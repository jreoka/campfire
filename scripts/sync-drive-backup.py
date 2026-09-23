#!/usr/bin/env python3
"""Sync the Google Drive git_repos/campfire backup working tree to a git commit.

Google Drive doesn't speak git, so this is the one-command equivalent of
`git pull` for the backup:

    python3 scripts/sync-drive-backup.py [--check] [--to <rev>]

It fast-forwards the Drive working tree from the last-synced commit (recorded
in ~/.campfire-drive-sync-state) to the target rev (default HEAD): new and
changed files are uploaded with exact git bytes, files deleted in git are
trashed in Drive. Change detection comes from git itself, so Drive's CRLF
line endings never cause spurious uploads.

With --check, prints what would change without touching Drive.
With no state file yet, does one full-tree verification pass first.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = os.path.expanduser("~/.campfire-drive-sync-state")
FOLDER_MIME = "application/vnd.google-apps.folder"
TMPDIR = os.path.expanduser("~/workspace/.tmp-drive-sync")


def sh(*args, cwd=REPO):
    r = subprocess.run(list(args), capture_output=True, text=True, cwd=cwd)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:3])} failed: {r.stderr[:400]}")
    return r.stdout


def drive(*args):
    r = subprocess.run(["hatch_gws_cli", "drive"] + list(args),
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"drive {' '.join(args[:3])} failed: {r.stderr[:400]}")
    out = r.stdout.strip()
    return json.loads(out) if out else {}


def find_child(parent_id, name):
    q = f"'{parent_id}' in parents and name = '{name}' and trashed=false"
    r = drive("files", "list", "--params",
              json.dumps({"q": q, "pageSize": 5,
                          "fields": "files(id,name,mimeType)"}))
    fs = r.get("files", [])
    return fs[0] if fs else None


def drive_root():
    r = drive("files", "list", "--params",
              json.dumps({"q": f"name='git_repos' and "
                               f"mimeType='{FOLDER_MIME}' and trashed=false",
                          "pageSize": 5, "fields": "files(id)"}))
    gid = r["files"][0]["id"]
    camp = find_child(gid, "campfire")
    if not camp:
        raise RuntimeError("git_repos/campfire not found in Drive")
    return camp["id"]


def list_tree(root_id):
    """relpath -> {'id':..., 'mime':...} for everything under root_id."""
    out = {}
    stack = [(root_id, "")]
    while stack:
        fid, prefix = stack.pop()
        page = None
        while True:
            params = {"q": f"'{fid}' in parents and trashed=false",
                      "pageSize": 1000,
                      "fields": "files(id,name,mimeType),nextPageToken"}
            if page:
                params["pageToken"] = page
            r = drive("files", "list", "--params", json.dumps(params))
            for f in r.get("files", []):
                rel = f"{prefix}{f['name']}"
                out[rel] = {"id": f["id"], "mime": f["mimeType"]}
                if f["mimeType"] == FOLDER_MIME:
                    stack.append((f["id"], rel + "/"))
            page = r.get("nextPageToken")
            if not page:
                break
    return out


def ensure_parent(root_id, tree, rel, check):
    """Return the Drive id of rel's parent dir, creating missing dirs."""
    parts = rel.split("/")[:-1]
    pid, prefix = root_id, ""
    for p in parts:
        prefix = f"{prefix}{p}/"
        ent = tree.get(prefix.rstrip("/"))
        if ent and ent["mime"] == FOLDER_MIME:
            pid = ent["id"]
        else:
            if check:
                raise RuntimeError(f"would create Drive folder {prefix}")
            r = drive("files", "create",
                      "--params",
                      json.dumps({"ignoreDefaultVisibility": True}),
                      "--json",
                      json.dumps({"name": p, "mimeType": FOLDER_MIME,
                                  "parents": [pid]}))
            pid = r["id"]
            tree[prefix.rstrip("/")] = {"id": pid, "mime": FOLDER_MIME}
            print(f"  mkdir {prefix}")
    return pid


def git_bytes(rev, path):
    return subprocess.run(["git", "show", f"{rev}:{path}"],
                          capture_output=True, cwd=REPO).stdout


def norm(b):
    return b.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def upload_new(root_id, tree, rev, rel, check):
    if check:
        print(f"  + {rel}")
        return
    pid = ensure_parent(root_id, tree, rel, check)
    os.makedirs(TMPDIR, exist_ok=True)
    tmp = os.path.join(TMPDIR, os.path.basename(rel) or "f")
    with open(tmp, "wb") as f:
        f.write(git_bytes(rev, rel))
    r = drive("+upload", tmp, "--parent", pid, "--name",
              os.path.basename(rel))
    tree[rel] = {"id": r["id"], "mime": r.get("mimeType", "")}
    os.remove(tmp)
    print(f"  + {rel}")


def upload_update(tree, rev, rel, check):
    if check:
        print(f"  ~ {rel}")
        return
    os.makedirs(TMPDIR, exist_ok=True)
    tmp = os.path.join(TMPDIR, os.path.basename(rel) or "f")
    with open(tmp, "wb") as f:
        f.write(git_bytes(rev, rel))
    drive("files", "update",
          "--params", json.dumps({"fileId": tree[rel]["id"]}),
          "--upload", tmp)
    os.remove(tmp)
    print(f"  ~ {rel}")


def trash(tree, rel, check):
    if check:
        print(f"  - {rel}")
        return
    drive("files", "update",
          "--params", json.dumps({"fileId": tree[rel]["id"]}),
          "--json", json.dumps({"trashed": True}))
    del tree[rel]
    print(f"  - {rel}")


def main():
    check = "--check" in sys.argv
    to_rev = "HEAD"
    if "--to" in sys.argv:
        to_rev = sys.argv[sys.argv.index("--to") + 1]
    to_rev = sh("git", "rev-parse", to_rev).strip()

    root_id = drive_root()
    print(f"Drive: git_repos/campfire (target {to_rev[:12]})")
    tree = list_tree(root_id)

    if os.path.exists(STATE_FILE):
        from_rev = open(STATE_FILE).read().strip()
        print(f"Last synced: {from_rev[:12] or '(none)'}")
        if from_rev == to_rev:
            print("Already in sync — nothing to do.")
            return
        diff = sh("git", "diff", "--name-status", "--no-renames", "-z",
                  from_rev, to_rev)
        parts = [p for p in diff.split("\0") if p]
        i = 0
        changed = False
        while i < len(parts):
            status, rel = parts[i][0], parts[i][1:]
            i += 1
            if status in ("A", "M"):
                ent = tree.get(rel)
                if ent and ent["mime"] != FOLDER_MIME:
                    upload_update(tree, to_rev, rel, check)
                else:
                    if ent:  # a dir where a file should be; shouldn't happen
                        trash(tree, rel, check)
                    upload_new(root_id, tree, to_rev, rel, check)
                changed = True
            elif status == "D":
                if rel in tree:
                    trash(tree, rel, check)
                    changed = True
            # T (type change) etc: treat as re-upload
            elif rel in tree:
                upload_update(tree, to_rev, rel, check)
                changed = True
        if not changed:
            print("No file changes between revs.")
    else:
        # No state: full-tree verification against the target rev.
        print("No sync state — doing a full verification pass.")
        local = sh("git", "ls-tree", "-r", "--name-only", "-z",
                   to_rev).split("\0")
        local = [p for p in local if p]
        local_set = set(local)
        for rel in sorted(local):
            ent = tree.get(rel)
            if not ent:
                upload_new(root_id, tree, to_rev, rel, check)
            elif ent["mime"] == FOLDER_MIME:
                trash(tree, rel, check)
                upload_new(root_id, tree, to_rev, rel, check)
            else:
                tmp = os.path.join(TMPDIR, "v")
                os.makedirs(TMPDIR, exist_ok=True)
                subprocess.run(
                    ["hatch_gws_cli", "drive", "files", "get", "--params",
                     json.dumps({"fileId": ent["id"], "alt": "media"}),
                     "--output", tmp], capture_output=True, check=True)
                with open(tmp, "rb") as f:
                    remote = f.read()
                os.remove(tmp)
                if norm(remote) != norm(git_bytes(to_rev, rel)):
                    upload_update(tree, to_rev, rel, check)
        for rel in sorted(set(tree) - local_set):
            if tree[rel]["mime"] != FOLDER_MIME:
                trash(tree, rel, check)
        # drop dirs that ended up empty? Drive keeps them; harmless.

    if not check:
        with open(STATE_FILE, "w") as f:
            f.write(to_rev + "\n")
        print(f"State stamped at {to_rev[:12]}")
    else:
        print("(dry run — Drive untouched)")


if __name__ == "__main__":
    main()
