#!/usr/bin/env python3
"""Thin shim so users can run `python3 install.py install ./savemedia-host-…`.

Delegates to savemedia_host.installer.main. Lives at the package root so
the install instructions are short and obvious.
"""
from __future__ import annotations

import sys

from savemedia_host.installer import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
