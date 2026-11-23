# LinuxPanel

A single-server web control panel written in Python with the standard library only. It runs as root under systemd, authenticates against PAM with existing Linux accounts, and gives you a dashboard, a tmux-backed terminal that survives browser close and panel restarts, a file manager that runs with your own permissions, account management, SSH hardening and git-based self-update.

No node, no npm, no build step, no pip dependencies.

## Features

- **Dashboard** — hostname, OS, kernel, uptime, load, CPU, memory, swap, disks and the top 15 processes by CPU, sampled from `/proc`.
- **Terminal** — real tmux sessions (`tmux -L linuxpanel`), one per tab. Sessions keep running when you close the browser, restart the service or apply a self-update.
- **Files** — browse, read, edit, upload, download, rename, copy, move, delete, chmod. Every operation runs in a subprocess with privileges dropped to the logged-in user, so the file manager sees exactly what your SSH session sees.
- **Accounts** — create and delete users, reset passwords, set supplementary groups, toggle sudo, lock passwords, block panel access, block SSH access, manage `authorized_keys` (with SHA256 fingerprints), and read SSH and panel login history.
- **Security** — root hardening (password lock + `PermitRootLogin no` + panel block) and per-user SSH denial through a managed block at the top of `sshd_config`, validated with `sshd -t` before reload.
- **Audit log** — append-only JSON lines for logins, account changes, file deletes/uploads and updates.
- **Self-update** — the Settings page pulls the configured branch from git and restarts the service.
- **Dark UI** — vanilla ES modules, xterm.js, no web fonts, no images.

Screenshots: none yet.

## Requirements

- Linux with systemd (any distribution with apt, dnf, yum, pacman, zypper or apk).
- Python 3.8 or newer, `tmux`, `git`, `openssl`, PAM.
- Root access to install.
- No node/npm and no Python packages beyond the standard library.

## Install

One command:

```sh
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/linuxpanel/main/install.sh | sudo bash
```

From a local checkout:

```sh
sudo ./install.sh
```

The installer installs only the packages that are missing, copies or clones the code to `/opt/linuxpanel`, creates `/etc/linuxpanel`, `/var/lib/linuxpanel` and `/var/log/linuxpanel`, writes a config file if there is none, generates a self-signed certificate, writes `/etc/pam.d/linuxpanel`, installs and starts the systemd unit, and prints the URL. It never installs or reconfigures a web server, and it never changes your firewall — if ufw or firewalld is active it prints the command to open the port.

### Install options

Every option is an environment variable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `LP_REPO` | `https://github.com/YOUR_GITHUB_USER/linuxpanel.git` | git remote to clone |
| `LP_BRANCH` | `main` | branch to clone and track |
| `LP_PORT` | `4080` | listen port |
| `LP_DIR` | `/opt/linuxpanel` | install directory |
| `LP_BIND` | `0.0.0.0` | bind address |
| `LP_NO_TLS` | unset | set to any value to serve plain HTTP |

```sh
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/linuxpanel/main/install.sh | sudo LP_PORT=4443 bash
```

```sh
sudo LP_PORT=4443 LP_BIND=127.0.0.1 LP_DIR=/srv/linuxpanel ./install.sh
```

Re-running the installer is the upgrade path: an existing git checkout is fetched and reset to `origin/$LP_BRANCH`, an existing `config.json` and certificate are kept, and the service is restarted.

## First login

Open `https://<server-ip>:4080/`. The certificate is self-signed, so the browser warns once — accept it.

Log in with any existing Linux account and its system password. Nothing is stored by the panel; the password goes straight to PAM. Members of `sudo`, `wheel` or `admin` (configurable) and uid 0 get admin rights; everyone else gets the dashboard, terminal, files and their own preferences.

`root` can log in unless the account is hardened. Recommended: create a normal user, add it to `sudo`, log in as that user and enable **Harden root** on the Security page.

## Port and TLS

The default port is 4080. To change it, edit `/etc/linuxpanel/config.json` and restart:

```sh
sudo systemctl restart linuxpanel
```

The certificate and key live in `/etc/linuxpanel/cert.pem` and `/etc/linuxpanel/key.pem`; replace them with your own and restart. If TLS is enabled but the files are missing, the panel logs a warning and serves plain HTTP.

## Configuration

`/etc/linuxpanel/config.json` (mode 600). Missing keys fall back to the defaults below.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4080` | TCP port to listen on |
| `bind` | `"0.0.0.0"` | bind address |
| `tls` | `true` | serve HTTPS; falls back to HTTP if the cert is missing |
| `cert` | `"/etc/linuxpanel/cert.pem"` | certificate path |
| `key` | `"/etc/linuxpanel/key.pem"` | private key path |
| `session_hours` | `12` | idle session expiry in hours |
| `admin_groups` | `["sudo", "wheel", "admin"]` | groups that grant admin rights |
| `login_group` | `""` | if set, only members of this group may log in (root always may) |
| `pam_service` | `"linuxpanel"` | PAM service name, i.e. `/etc/pam.d/linuxpanel` |
| `repo` | `"https://github.com/YOUR_GITHUB_USER/linuxpanel.git"` | git remote used by self-update |
| `branch` | `"main"` | branch used by self-update |
| `max_upload_mb` | `4096` | upload size limit |
| `service_name` | `"linuxpanel"` | systemd unit restarted after an update |

Command line flags `--config PATH`, `--port N`, `--bind ADDR` and `--no-tls` override the file for a single run.

## Self-update

Settings → **Check for updates** compares `HEAD` with `git ls-remote <repo> refs/heads/<branch>`; **Update** runs `git fetch origin <branch>` and `git reset --hard origin/<branch>` in the install directory, then restarts the service about a second later. Terminal sessions survive that restart because the unit uses `KillMode=process`.

Set `repo` to your own fork (or leave it at the default and the panel falls back to the `origin` remote of the existing checkout). The install directory must be a git checkout for updates to work.

## Security model

- **PAM authentication.** `pam_authenticate` plus `pam_acct_mgmt` through `libpam.so.0`; passwords are never stored, hashed or logged by the panel.
- **No privilege escalation for users.** The file manager and terminals run as the logged-in user with that user's normal permissions (`initgroups` + `setgid` + `setuid`). The panel process is root only so it can drop privileges and manage accounts.
- **Admin** is uid 0 or membership of a group in `admin_groups`. Account, security, audit, login-history, settings and update endpoints are admin only.
- **Sessions** are random 32-byte tokens in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` under TLS), persisted to `/var/lib/linuxpanel/sessions.json` so a restart does not log you out. Blocking, locking or deleting a user destroys their sessions.
- **CSRF.** Every non-GET `/api/*` request must send `X-LP: 1`. WebSocket upgrades must come from the same host and port as the `Host` header.
- **Login rate limiting.** 5 failures within 10 minutes per client IP and per username locks that pair out for 15 minutes (HTTP 429).
- **sshd managed block.** SSH changes are written as a `# BEGIN LINUXPANEL MANAGED BLOCK` block at the very top of `/etc/ssh/sshd_config` (first value wins in sshd), after copying the file to `/etc/ssh/sshd_config.linuxpanel.bak`. The result is validated with `sshd -t`; on failure the backup is restored and the API returns an error. The block is removed entirely when nothing needs to be denied.
- **Response headers.** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a strict `Content-Security-Policy`, and `Cache-Control: no-store` for API responses.
- **Audit.** Logins, failures, account changes, file deletes/uploads and updates are appended to `/var/log/linuxpanel/audit.log`.

## Files and paths

| Path | Purpose |
| --- | --- |
| `/opt/linuxpanel` | install directory (git checkout, `linuxpanel` package, `static/`, `tmux.conf`) |
| `/etc/linuxpanel/config.json` | configuration, mode 600 |
| `/etc/linuxpanel/cert.pem`, `key.pem` | TLS certificate and key (key mode 600) |
| `/etc/pam.d/linuxpanel` | PAM service used for login |
| `/etc/systemd/system/linuxpanel.service` | systemd unit |
| `/var/lib/linuxpanel/` | state, mode 700: `state.json`, `sessions.json`, `users/<name>.json` |
| `/var/log/linuxpanel/audit.log` | audit log, JSON lines, mode 600 |

## Uninstall

```sh
sudo /opt/linuxpanel/uninstall.sh
```

Stops and disables the service, removes the unit, `/etc/pam.d/linuxpanel` and the install directory. `/etc/linuxpanel`, `/var/lib/linuxpanel` and `/var/log/linuxpanel` are kept unless you pass `--purge`, which also removes them and the LINUXPANEL managed block from `sshd_config` (validated with `sshd -t`, then ssh is reloaded). Without `--purge` an existing managed block is left in place and reported.

## Publishing to GitHub

1. Create the repository and push this tree.
2. Replace `YOUR_GITHUB_USER` in `install.sh` (`LP_REPO` default), in `linuxpanel/config.py` (`repo` default) and in this README.
3. Keep the files at LF line endings — `.gitattributes` enforces that for scripts, units and sources.
4. The one-command installer then works against `main`.

## Troubleshooting

- **Service logs:** `journalctl -u linuxpanel -f`.
- **Port already in use:** `ss -ltnp | grep 4080`, then change `port` in `/etc/linuxpanel/config.json` and `systemctl restart linuxpanel`.
- **PAM errors / login always fails:** check `/etc/pam.d/linuxpanel` exists and matches your distribution (`@include common-auth` on Debian family, `auth include system-auth` on RHEL family, `auth include login` elsewhere), and that the account has a real login shell (`/etc/passwd`, not `nologin` or `false`).
- **Certificate warning:** expected with the self-signed certificate; replace `cert.pem`/`key.pem` or put the panel behind your own TLS terminator.
- **Terminal says tmux is not installed:** `apt-get install tmux` (or your package manager) and restart the service.
- **Update fails:** the install directory must be a git checkout with a reachable `origin`; check `git -C /opt/linuxpanel remote -v` and that `repo`/`branch` in the config are correct.
- **Cannot reach the panel from outside:** open the port in the firewall (`ufw allow 4080/tcp` or `firewall-cmd --permanent --add-port=4080/tcp && firewall-cmd --reload`); the installer prints the exact command when it detects an active firewall.
