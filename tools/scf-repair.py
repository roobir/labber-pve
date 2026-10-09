#!/usr/bin/env python3
"""Remove stray fragments left in an exported BIG-IP config (SCF).

An older f5-export-config filter could leak the tail of a stanza it meant to
drop (the continuation lines of a multi-line certificate/key value start with
a lowercase letter, which it mistook for a new stanza). The leftover lines sit
outside any stanza and make F5's check fail with
"Syntax Error ... unexpected argument". This finds and removes them.

    pbpaste | python3 tools/scf-repair.py | pbcopy      # macOS clipboard
    python3 tools/scf-repair.py < in.scf > out.scf

Options (use --all unless you know you want only one):
  --drop-encrypted  also remove every object holding a value encrypted with a
                    device master key (`$M$...`, e.g. a bot signature's
                    `factory_rule` or a monitor password). Another BIG-IP
                    cannot decrypt it ("01071769 ... different master key").
  --drop-files      also remove every object with a `cache-path` line: it
                    points at a file in the original device's file store
                    ("01070712 ... Cache path ... does not exist").
  --all             all of the above.
A comment at the end of the output lists the objects that were left out.

    pbpaste | python3 tools/scf-repair.py --all | pbcopy

What was removed is listed on stderr, so you can see exactly what went. Lines
are only removed when they sit at the very top level of the file and are not a
comment, a blank line or a stanza header (a line starting with a lowercase
word and ending in a brace). A clean file comes out unchanged.
"""
import re
import sys

HEADER = re.compile(r"^[a-z].*[{}][ \t]*$")


def braces(line):
    """Net brace count of a line, ignoring backslash-escaped braces."""
    bare = re.sub(r"\\.", "", line)
    return bare.count("{") - bare.count("}")


def repair(text):
    out, removed = [], []
    depth = 0          # brace depth inside well-formed stanzas
    orphan = False     # inside a stray fragment
    odepth = 0
    for line in text.split("\n"):
        if orphan:
            if odepth == 0 and HEADER.match(line) and not line.startswith("}"):
                orphan = False                      # a real stanza starts again: fragment is over
            else:
                delta = braces(line)
                removed.append(line)
                if odepth + delta < 0:
                    orphan, odepth = False, 0       # the unmatched closing brace ends it
                else:
                    odepth += delta
                continue
        if depth <= 0:
            depth = 0
            top_level_ok = (not line.strip()) or line.startswith("#") or HEADER.match(line)
            if not top_level_ok and not line.startswith(" ") and not line.startswith("\t"):
                orphan, odepth = True, braces(line)
                removed.append(line)
                continue
        out.append(line)
        depth += braces(line)
    return "\n".join(out), removed


ENCRYPTED = re.compile(r"\$M\$")
FILE_BACKED = re.compile(r"^[ \t]+cache-path[ \t]", re.MULTILINE)


def drop_device_specific(text, encrypted=True, files=True):
    """Split into stanzas (a header line starts one) and leave out those that only work on the
    device they came from: values encrypted with its master key ($M$...), or a `cache-path`
    pointing at a file in its file store."""
    segments, current = [], []
    for line in text.split("\n"):
        if HEADER.match(line) and current:
            segments.append(current)
            current = []
        current.append(line)
    if current:
        segments.append(current)
    kept, dropped = [], []
    for seg in segments:
        body = "\n".join(seg)
        if encrypted and ENCRYPTED.search(body):
            dropped.append("(encrypted value) " + seg[0])
        elif files and FILE_BACKED.search(body):
            dropped.append("(file on the device) " + seg[0])
        else:
            kept.extend(seg)
    out = "\n".join(kept)
    if dropped:
        out = out.rstrip("\n") + "\n\n# scf-repair: left out these objects, which only work on the device they came from:\n"
        out += "".join(f"#   {h}\n" for h in dropped[:40])
        if len(dropped) > 40:
            out += f"#   ... and {len(dropped) - 40} more\n"
    return out, dropped


drop_encrypted = drop_device_specific  # older name


if __name__ == "__main__":
    flags = set(sys.argv[1:])
    fixed, gone = repair(sys.stdin.read())
    left_out = []
    if flags & {"--all", "--drop-encrypted", "--drop-files"}:
        everything = "--all" in flags
        fixed, left_out = drop_device_specific(
            fixed, encrypted=everything or "--drop-encrypted" in flags, files=everything or "--drop-files" in flags)
    sys.stdout.write(fixed)
    if left_out:
        print(f"scf-repair: left out {len(left_out)} object(s) that only work on the device they came from:", file=sys.stderr)
        for h in left_out[:20]:
            print("   " + (h if len(h) < 100 else h[:97] + "..."), file=sys.stderr)
        if len(left_out) > 20:
            print(f"   ... and {len(left_out) - 20} more", file=sys.stderr)
    if gone:
        print(f"scf-repair: removed {len(gone)} stray line(s):", file=sys.stderr)
        for line in gone[:20]:
            print("   " + (line if len(line) < 90 else line[:87] + "..."), file=sys.stderr)
        if len(gone) > 20:
            print(f"   ... and {len(gone) - 20} more", file=sys.stderr)
    elif not left_out:
        print("scf-repair: nothing to remove", file=sys.stderr)
