#!/usr/bin/env python3
"""Configure the free Gemini/Workers backend; read secrets privately from a terminal."""
import getpass
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "EviIius/Victor-Potential-Laptops"
MODEL = "gemini-3.5-flash-lite"


def gh(*args, value=None):
    result = subprocess.run(
        ["gh", *args], input=value, text=True, capture_output=True, check=False
    )
    if result.returncode:
        # Do not relay subprocess output: it may contain credential-related details.
        raise RuntimeError(f"GitHub could not complete {' '.join(args[:2])}. Check gh auth status and repository access.")
    return result.stdout.strip()


def check_url(url, headers, label):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{label} check failed (HTTP {error.code}). Check the account and key permissions.") from None
    except (OSError, ValueError):
        raise RuntimeError(f"Could not reach {label}. Check your internet connection and retry.") from None


def main():
    if not sys.stdin.isatty():
        raise RuntimeError("Run this script in your own terminal so secret input can stay hidden.")
    if not shutil.which("gh"):
        raise RuntimeError("Install GitHub CLI (https://cli.github.com), then run gh auth login.")
    gh("repo", "view", REPO, "--json", "name")
    print("Free setup: Cloudflare Workers + Gemini Flash-Lite. No local server stays running.")
    print("Create a Gemini key: https://aistudio.google.com/apikey")
    print("Create a free Cloudflare account: https://dash.cloudflare.com/sign-up")
    print("Cloudflare API token: https://dash.cloudflare.com/profile/api-tokens")
    print("Use the Edit Cloudflare Workers template, scoped to your account.")
    print("Find your Account ID on the Cloudflare account dashboard.")
    print("Secret input stays hidden and goes directly to GitHub's encrypted Actions secrets.\n")
    account = input("Cloudflare Account ID: ").strip()
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise RuntimeError("The Account ID must be the 32-character ID shown by Cloudflare.")
    cf_token = getpass.getpass("Cloudflare API token (hidden): ").strip()
    gemini_key = getpass.getpass("Gemini API key (hidden): ").strip()
    code = getpass.getpass("Choose a chat access code to share with Victor (16+ characters, hidden): ").strip()
    if not cf_token or not gemini_key or not 16 <= len(code) <= 512:
        raise RuntimeError("Both API credentials are required; the chat code must be 16–512 characters.")
    if code != getpass.getpass("Repeat chat access code (hidden): ").strip():
        raise RuntimeError("The chat codes did not match.")
    check_url(f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts", {"Authorization": f"Bearer {cf_token}"}, "Cloudflare")
    check_url(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}", {"x-goog-api-key": gemini_key}, "Gemini")
    for name, value in (("CLOUDFLARE_API_TOKEN", cf_token), ("GEMINI_API_KEY", gemini_key), ("CHAT_ACCESS_TOKEN", code)):
        gh("secret", "set", name, "--repo", REPO, value=value)
    gh("variable", "set", "CLOUDFLARE_ACCOUNT_ID", "--repo", REPO, "--body", account)
    gh("workflow", "run", "deploy-gemini.yml", "--repo", REPO, "--ref", "main")
    print("\nSetup saved. GitHub is deploying the backend and connecting the live website.")
    print(f"Follow progress: https://github.com/{REPO}/actions/workflows/deploy-gemini.yml")
    print("Share only the chat access code with Victor. He enters it on the Ask Gemini page.")
    print("Chat: https://eviiius.github.io/Victor-Potential-Laptops/#chat")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyboardInterrupt, EOFError) as error:
        print(f"Setup stopped: {error or 'cancelled'}. No credentials were printed.", file=sys.stderr)
        sys.exit(1)
