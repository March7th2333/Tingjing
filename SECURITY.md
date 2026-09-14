# Security Policy

## Supported version

Security fixes currently target the newest source on `main` and the latest GitHub Release.

## Reporting a vulnerability

Please do not publish credentials, account sessions, private library data, or a working exploit in a public Issue.

Use GitHub's private security advisory feature for this repository when available. If it is unavailable, contact the maintainer through the GitHub profile first and share sensitive reproduction material only through a private channel agreed there.

Include the affected version, operating system, Provider, reproducible steps, impact, and a minimal redacted log. Remove QR codes, cookies, OAuth tokens, account IDs, personal playlists, and absolute local paths.

If a real Provider credential or session may already be exposed, revoke the
affected authorization with that Provider and rotate the account password where
applicable. Reporting the application flaw does not secure an exposed account;
never wait for an application update before taking those account-level steps.

## Scope

The project accepts reports about local credential handling, OAuth and QR-login state, Provider/account isolation, unsafe URL handling, update or packaging integrity, and vulnerabilities in the desktop application. Third-party service outages or policy disputes should be reported to the corresponding service instead.
