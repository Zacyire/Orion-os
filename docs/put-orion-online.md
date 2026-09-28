# How I put Orion OS online

This is a beginner's walkthrough, from nothing to `https://orion.YOUR_DOMAIN` working on your phone and school computer. It takes about an hour. [deployment.md](deployment.md) has the reasons behind each step.

Replace these placeholders everywhere:
- `YOUR_DOMAIN` — the domain you bought, e.g. `example.com`.
- `YOUR_SERVER` — the server's IP address.
- `YOUR_USER` — your login name on the server.

## Step 0 — Get the two things you have to buy

1. **A domain name** from any registrar, typically $10–15 a year.
2. **A small VPS** from any provider: Ubuntu 24.04 LTS, 2 GB RAM, typically $5–12 a month.
   - When creating it, add your SSH public key. On your computer, `ssh-keygen -t ed25519` creates one in `~/.ssh/id_ed25519.pub`.

You don't need GitHub Pages, and the repository stays private.

## Step 1 — Point the domain at the server

In your registrar's DNS settings, add a record: **type `A`, name `orion`, value `YOUR_SERVER`**. It can take anywhere from a few minutes to an hour to work.

## Step 2 — Log in and secure the server

```bash
ssh root@YOUR_SERVER                     # the provider tells you the first user; often root
adduser YOUR_USER && usermod -aG sudo YOUR_USER
rsync -a ~/.ssh /home/YOUR_USER/ && chown -R YOUR_USER: /home/YOUR_USER/.ssh
exit
ssh YOUR_USER@YOUR_SERVER                # from now on, log in as yourself

sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential pkg-config git curl caddy ufw unattended-upgrades
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

If your provider also has a firewall in its web dashboard, allow ports 22, 80 and 443 there too.

## Step 3 — Give the server read-only access to your private repo

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/orion_deploy
cat ~/.ssh/orion_deploy.pub
```

1. On GitHub, open your repository → **Settings → Deploy keys → Add deploy key**.
2. Paste the key and leave **"Allow write access" unticked**.
3. Back on the server:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/orion_deploy
EOF
git clone git@github.com:Zacyire/LTF-os.git ~/orion-os    # your repository's SSH address
```

## Step 4 — Install Rust (once)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

## Step 5 — Configure Orion OS (once)

```bash
cd ~/orion-os
sudo useradd --system --home /var/lib/orion-os --shell /usr/sbin/nologin orion-os
sudo install -d -m 0700 /etc/orion-os
sudo install -m 0600 deploy/orion-os.env.example /etc/orion-os/orion-os.env
sudo sed -i 's/orion.YOUR_DOMAIN/orion.example.com/' /etc/orion-os/orion-os.env   # ← your hostname

openssl rand -hex 16 | sudo tee /etc/orion-os/access-key >/dev/null
sudo chmod 0600 /etc/orion-os/access-key
sudo cat /etc/orion-os/access-key        # ← your access key: save it in your password manager

sudo cp deploy/orion-os.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable orion-os
```

## Step 6 — Build and start it

```bash
./deploy/update.sh --no-pull --test      # builds (a few minutes), installs to /opt/orion-os, starts it
```

It should end with `==> Orion OS is up`. If it fails, see "When something goes wrong" below.

## Step 7 — Turn on HTTPS

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/orion.YOUR_DOMAIN/orion.example.com/' /etc/caddy/Caddyfile   # ← your hostname
sudo systemctl reload caddy
curl -fsS https://orion.example.com/healthz     # → ok
```

Caddy gets the certificate by itself. If `curl` fails, wait a minute; DNS may still be updating.

## Step 8 — Open it

1. Visit `https://orion.example.com` and enter the access key.
2. Tick **"Keep me signed in"** only on your own devices.
3. Go through [deployment-checklist.md](deployment-checklist.md) once.

**On a school or shared computer:**
- Leave "Keep me signed in" unticked.
- Don't let the browser save the key.
- When you're done, use **Settings → System → Erase & sign out**.
- If the school network blocks the site, that's the school's decision. Don't try to get around it.

## Later: updating after you push changes to GitHub

```bash
ssh YOUR_USER@YOUR_SERVER
cd ~/orion-os && ./deploy/update.sh
```

That's all. Your data in `/var/lib/orion-os` is never touched by updates. If an update breaks something:

```bash
git log --oneline -5                               # find the last good commit
git checkout <good-commit> && ./deploy/update.sh --no-pull
git checkout main                                  # when a fix is pushed, then ./deploy/update.sh
```

## Later: backups

Run once, to back up every night at 03:15:

```bash
(sudo crontab -l 2>/dev/null; echo "15 3 * * * /home/YOUR_USER/orion-os/deploy/backup.sh >/dev/null") | sudo crontab -
```

About once a month, copy the newest backup to your own computer (see [deployment.md §10](deployment.md#10-backups)).

## Later: changing the access key

Do this if it leaked, or to sign out every device:

```bash
openssl rand -hex 16 | sudo tee /etc/orion-os/access-key >/dev/null
sudo systemctl restart orion-os && sudo cat /etc/orion-os/access-key
```

## When something goes wrong

```bash
sudo systemctl status orion-os caddy     # are both running?
journalctl -u orion-os -n 50             # Orion OS messages (e.g. "refusing to start: …")
journalctl -u caddy -n 50                # certificate / proxy messages
```

The troubleshooting table in [deployment.md §12](deployment.md#12-troubleshooting) covers the common cases: DNS, certificates, 502, 403, sign-in loops and WebSockets.
