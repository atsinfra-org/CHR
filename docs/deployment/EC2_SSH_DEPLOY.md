# Deploying the CHR website to EC2 over SSH

`.github/workflows/deploy.yml` builds the site on GitHub Actions and copies only the
production build to the EC2 instance over SSH. Nothing else about the site changes:
DNS, TLS, Supabase, the Edge Functions and the Netlify hosting are not touched.

```
push to main -> lint, typecheck, tests, build (GitHub) -> SSH/SCP -> EC2
  /var/www/chr  <- validated, copied file by file, index.html last
  nginx -t -> reload -> health check on the server -> restore index.html if it fails
```

## GitHub repository secrets

| Secret | Value | Kind |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL | public (compiled into the site) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key | public (compiled into the site) |
| `EC2_HOST` | `54.66.102.139` (must be an **Elastic IP**, or the address changes when the instance restarts) | not secret |
| `EC2_USER` | `ec2-user` | not secret |
| `EC2_SSH_PRIVATE_KEY` | the private half of a key pair made only for this deploy | **secret** |
| `EC2_KNOWN_HOSTS` | the server's pinned SSH host key line (below) | not secret, but integrity matters |

No AWS credentials, no OIDC and no S3 are used any more. Nothing in the repository
contains a key.

## One-time setup

1. **Make a deploy key** on your own computer (not on the server), no passphrase:
   `ssh-keygen -t ed25519 -C chr-github-deploy -N "" -f chr-deploy`
   This creates `chr-deploy` (private) and `chr-deploy.pub` (public).
2. **Install the public key** on the server: add the single line from `chr-deploy.pub` to
   `/home/ec2-user/.ssh/authorized_keys` (use your existing access, e.g. EC2 Instance
   Connect or your current key). Do not remove your own key.
3. **Pin the host key.** The fingerprint must come from the server itself, not only from
   the network:
   - On the server: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
   - On your computer: `ssh-keyscan -t ed25519 54.66.102.139 > known_hosts.txt`, then
     `ssh-keygen -lf known_hosts.txt`
   - The two fingerprints must be identical. The contents of `known_hosts.txt`
     (a line like `54.66.102.139 ssh-ed25519 AAAA...`) are the `EC2_KNOWN_HOSTS` secret.
     The workflow refuses wildcard entries and entries for a different host.
4. **Add the four secrets** in GitHub: Settings -> Secrets and variables -> Actions.
   `EC2_SSH_PRIVATE_KEY` is the whole contents of the `chr-deploy` file, including the
   BEGIN and END lines. Then delete the local copy of `chr-deploy` or keep it in a
   password manager.
5. **Check the server** (the deploy does not set any of this up):
   - `/var/www/chr` exists and Nginx serves it, with the SPA fallback
     (`try_files $uri $uri/ /index.html;`).
   - `sudo -n true` works for `ec2-user` (Amazon Linux's default).
   - Nginx answers for `colonelhorseriding.com` on `127.0.0.1`. The health check requests
     `/`, the new JavaScript file and `/account` with that Host name. If HTTP redirects
     to HTTPS, port 443 must already work locally.
   - Password login is off: `sudo sshd -T | grep -i passwordauthentication` says `no`.

## Network access (not changed by the workflow)

The workflow connects from GitHub-hosted runners to **TCP port 22** of the instance.
Nothing opens it for you; the security group is yours to decide.

- GitHub's runner addresses are many and change often
  (`https://api.github.com/meta`, the `actions` list), which is far more than a security
  group can hold. In practice this means allowing port 22 from `0.0.0.0/0`.
- If you do that, rely on the controls that remain: key-only login, a key used for
  nothing else, a patched server, `PermitRootLogin no`, and optionally `fail2ban`.
  Expect constant scanning noise in the SSH log; it is harmless against key-only login.
- Tighter options: a **self-hosted runner** (inside your network, port 22 closed to the
  internet), or opening port 22 only while a deploy runs. The second needs AWS
  permissions, which your organisation currently blocks.

## Security considerations

- The deploy key logs in as `ec2-user` with passwordless sudo, so **whoever can change
  `main` or read this secret has root on the server**. Protect `main` (branch protection,
  required reviews) and limit who can edit workflows and secrets.
- The workflow only needs read access to the repository (`permissions: contents: read`).
  The secrets reach shell steps as environment variables only; host and user are checked
  against a strict pattern before they are written to the SSH config.
- Host-key checking is on and only the pinned key is trusted. If the instance is rebuilt
  or its address changes, the host key changes and the deploy stops until you update
  `EC2_KNOWN_HOSTS`. That is the intended protection.
- Stronger later: a dedicated `deploy` user whose sudo is limited to the deploy script,
  and a GitHub Environment with required reviewers so each production deploy needs approval.
- Rotate the key if anyone who had access leaves: replace the line in `authorized_keys`
  and the `EC2_SSH_PRIVATE_KEY` secret.

## First deployment

Pushing to `main` starts a deploy immediately. Until all four `EC2_*` secrets exist the
run stops at "Set up SSH" with a clear message, after lint, tests and the build, and
nothing is sent to the server.

1. Complete the setup above.
2. Confirm port 22 is reachable from outside (for example from your phone's hotspot):
   `ssh -i chr-deploy ec2-user@54.66.102.139 true`
3. Run the workflow: Actions -> Deploy website -> Run workflow (branch `main`), or push.
4. Read the "Deploy on the server" output; it should end with `DEPLOY OK`.
5. Look at the site **on the server** before any DNS change, because the domain still
   points at Netlify: `curl --resolve colonelhorseriding.com:443:54.66.102.139 https://colonelhorseriding.com/`
   or a hosts-file entry on your computer.

## What the server-side script guarantees

- The upload is checked against a SHA-256 from the build, rejected if it has absolute or
  `..` paths, links or special files, and must contain an `index.html` that is the CHR app
  and every `/assets/` file it references. All of this happens in a temporary directory.
- Files are replaced one at a time, each atomically, `index.html` last. Existing unrelated
  files in `/var/www/chr` (for example `.well-known/`) are never deleted.
- Only Vite's hashed `.js` and `.css` files in `assets/` older than 14 days are pruned.
- If `nginx -t`, the reload or the health check fails, the previous `index.html` is put
  back and the workflow fails.
- To roll back further, re-run the workflow of an earlier successful run (it rebuilds that
  commit) or revert the commit on `main`.

## Troubleshooting

| Message | Likely cause |
|---|---|
| `The repository secret EC2_... is empty or missing` | the secret is not set yet |
| `EC2_KNOWN_HOSTS has no host key for EC2_HOST` | the known_hosts line names a different address than `EC2_HOST` |
| `Could not log in to the server over SSH` | port 22 blocked, key not in `authorized_keys`, host key changed, or no passwordless sudo |
| `Host key verification failed` | the server's key no longer matches `EC2_KNOWN_HOSTS` (rebuilt instance?) |
| `nginx -t reported a configuration error` | an existing Nginx config problem, not the deploy |
| `GET /account did not fall back to the app` | the Nginx SPA fallback is missing |
