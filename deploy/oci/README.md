# Deploying on Oracle Cloud (OCI) — Always Free

One Arm VM in a public subnet runs two containers; the database is MySQL
HeatWave in the private subnet:

```
 Browser ──HTTPS──► VCN public subnet ─► VM (Oracle Linux or Ubuntu, Arm)
                    (security list:        ├─ caddy  :80/:443  TLS (Let's Encrypt), HTTP→HTTPS
                     80, 443 open;         └─ app    :3000     Next.js (not published)
                     22 from your IP)          │
                                               └─ /srv/workflow/data     backups
                                                  /srv/workflow/storage  encrypted uploads
                    VCN private subnet ─► MySQL HeatWave (private IP only, no internet access)
```

| File | What it is |
| --- | --- |
| `../../Dockerfile` | The app image. Starts by running `scripts/prepare-deploy.ts`, then `next start`. |
| `compose.yaml` | The app + Caddy, data mounted from `/srv/workflow`. |
| `Caddyfile` | HTTPS, certificate renewal, 20 MB upload cap, no access log. |
| `.env.example` | Settings template → copy to `.env` on the server. |
| `setup-vm.sh` | One-time VM setup on **Ubuntu**: firewall, Docker, data folders, daily jobs. On Oracle Linux, do the same by hand (see "Oracle Linux" below). |
| `deploy.sh` | First deploy and every update: pull, build, restart, wait for healthy. |
| `ops.sh` | `generate-periods`, `backup`, `logs`, `status`. |

> **First run.** The first start loads the firm's service catalog and email
> templates and prints a one-time link for `FIRST_ADMIN_EMAIL` to set their
> password (step 10). There is no demo data and no default password.

## Oracle Linux (the `opc` user)

`setup-vm.sh` assumes Ubuntu. On Oracle Linux 9 the equivalents are:

```bash
sudo dnf install -y git dnf-plugins-core nano
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y --allowerasing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker && sudo usermod -aG docker opc     # then log out and back in
sudo firewall-cmd --permanent --add-service=http --add-service=https && sudo firewall-cmd --reload
sudo mkdir -p /srv/workflow/{data,storage,logs}
sudo chown 1000:1000 /srv/workflow/data /srv/workflow/storage && sudo chmod 750 /srv/workflow/data /srv/workflow/storage
sudo chown opc:opc /srv/workflow/logs
```

SELinux stays enforcing; `compose.yaml` labels its volumes (`:Z`) so the
containers can use them. The daily jobs go in `/etc/cron.d/workflow` as in
step 11, with `opc` as the user and `/home/opc/workflow-app` as the path, then
`sudo systemctl enable --now crond`.

## The database (MySQL HeatWave)

Give the app its own login, limited to its database, rather than the admin one:

```sql
CREATE USER 'workflow_app'@'%' IDENTIFIED BY '<openssl rand -hex 24>';
GRANT ALL PRIVILEGES ON ktaxdb.* TO 'workflow_app'@'%';
```

Then in `.env`: `DB_PROVIDER="mysql"` and
`DATABASE_URL="mysql://workflow_app:<password>@<db private ip>:3306/ktaxdb?sslaccept=accept_invalid_certs"`.
The private subnet's security list needs TCP 3306 from the public subnet only.

---

## 1. Account

- Upgrade the tenancy to **Pay As You Go** (Billing → Upgrade). Always Free
  resources stay free, and Oracle stops reclaiming "idle" free VMs — an office
  app is idle every night and weekend.
- Optional: Identity → Compartments → create `workflow` and put everything
  below in it.
- Pick the **home region** closest to the firm. Always Free compute only runs
  there.

## 2. Network (VCN with a public subnet)

Networking → Virtual Cloud Networks → **Start VCN Wizard** →
**Create VCN with Internet Connectivity**:

| Field | Value |
| --- | --- |
| Name | `workflow-vcn` |
| VCN CIDR | `10.0.0.0/16` |
| Public subnet CIDR | `10.0.0.0/24` |
| Private subnet CIDR | `10.0.1.0/24` (for MySQL HeatWave later) |

The wizard creates both subnets, an Internet Gateway, a NAT Gateway, a Service
Gateway and their route tables.

## 3. Open the ports (public subnet security list)

Networking → Virtual Cloud Networks → `workflow-vcn` → **Security Lists** →
*Default Security List for workflow-vcn* (the one on the public subnet) →
**Add Ingress Rules**:

| Source CIDR | Protocol | Dest. port | Why |
| --- | --- | --- | --- |
| `0.0.0.0/0` | TCP | 80 | Let's Encrypt + redirect to HTTPS |
| `0.0.0.0/0` | TCP | 443 | The app |
| `0.0.0.0/0` | UDP | 443 | HTTP/3 (optional) |

Then edit the existing **TCP 22** rule: change its source from `0.0.0.0/0` to
**your own public IP** with `/32` (search "what is my IP"). Nobody else needs
SSH. (Alternative: delete the rule and use OCI Bastion.)

## 4. The VM

Compute → Instances → **Create instance**:

| Field | Value |
| --- | --- |
| Name | `workflow-app` |
| Image | **Canonical Ubuntu 24.04** |
| Shape | Ampere → **VM.Standard.A1.Flex**, 2 OCPU, 12 GB (shows *Always Free-eligible*) |
| Networking | `workflow-vcn`, **public subnet**, *Assign a public IPv4 address* ✔ |
| SSH keys | Upload your public key (or download the generated pair — keep it safe) |
| Boot volume | Specify a custom size: **100 GB** (Always Free allows 200 GB in total); in-transit encryption ✔ |

"Out of capacity" is common for Arm in busy regions: try another availability
domain, or retry later.

Optional but recommended: Networking → **Reserved Public IPs** → reserve one
and assign it to the VM's VNIC, so the IP survives the VM being recreated.

## 5. Boot volume backups

Storage → Block Storage → **Boot Volumes** → the VM's volume → *Backup policy*.
Always Free includes 5 volume backups, so use a custom policy that keeps no
more than 5 (e.g. weekly, keep 4). This is the "whole VM died" safety net;
the app's own nightly backup (step 11) is the "restore last Tuesday" one.

## 6. DNS

At the firm's DNS provider, add an **A record**: `workflow.yourfirm.com` →
the VM's public IP. Do this before step 9; Caddy can't get a certificate until
the name resolves to the VM. Check with `nslookup workflow.yourfirm.com`.

## 7. Get the code onto the VM and set it up

```bash
ssh ubuntu@<public-ip>

# A read-only deploy key for the GitHub repo
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "workflow-app VM"
cat ~/.ssh/github_deploy.pub
#   → GitHub: repo → Settings → Deploy keys → Add deploy key (leave write access off)
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF

git clone git@github.com:TempleToTummy/workflow-app.git
cd workflow-app
# (until these files are merged: git checkout <branch-with-deploy-files>)

sudo deploy/oci/setup-vm.sh
exit   # log out and back in so the docker group applies
```

## 8. Settings and secrets

```bash
ssh ubuntu@<public-ip>
cd workflow-app
cp deploy/oci/.env.example deploy/oci/.env
chmod 600 deploy/oci/.env

# Generate the secrets:
echo "DATA_ENCRYPTION_KEYS=\"$(date +%Y-%m):$(openssl rand -base64 32)\""
echo "DATA_INDEX_KEY=\"$(openssl rand -base64 32)\""
echo "AUTH_SECRET=\"$(openssl rand -hex 32)\""
echo "CRON_SECRET=\"$(openssl rand -hex 32)\""

nano deploy/oci/.env   # paste those in; set DOMAIN, APP_URL, ACME_EMAIL, DATABASE_URL,
                       # FIRST_ADMIN_EMAIL / FIRST_ADMIN_NAME and the email settings
```

**Put `DATA_ENCRYPTION_KEYS` and `DATA_INDEX_KEY` in the firm's password
manager now.** Every uploaded file, tax ID, SSN and backup is encrypted with
them; if the VM is lost and the keys with it, the data is unrecoverable.

## 9. Deploy

```bash
deploy/oci/deploy.sh --no-pull
```

The first build takes a few minutes on the A1. It ends with `Healthy.` Then
open `https://workflow.yourfirm.com` — the padlock should be there.

## 10. First sign-in

The first start prints a one-time link for `FIRST_ADMIN_EMAIL`:

```bash
docker compose -f deploy/oci/compose.yaml logs app | grep -A3 "First admin"
```

Open it, set the password, then turn on two-factor (Account page) and create
staff accounts from Admin → Employees. The link is valid for 7 days; until
it's used, each restart prints a new one and the old one stops working.

## 11. Check the daily jobs

`setup-vm.sh` installed `/etc/cron.d/workflow` (times are UTC):

| When | Job |
| --- | --- |
| 06:00 | `ops.sh generate-periods` — opens new periods and generates work |
| 02:30 | `ops.sh backup` — encrypted backup of the DB + uploads, keeps 14 |

Run both once by hand to confirm:

```bash
deploy/oci/ops.sh generate-periods   # prints 200 {"status":"SUCCESS",...}
deploy/oci/ops.sh backup             # prints "Backed up N rows ... → /data/backups/..."
tail /srv/workflow/logs/cron.log     # where the scheduled runs write
```

The backups sit on the same disk as the database. Copy them somewhere else
too — OCI Object Storage (10 GB free) or the firm's own storage.

## Updating

```bash
cd ~/workflow-app && deploy/oci/deploy.sh
```

Pulls, rebuilds and restarts. The site is down for about a minute while the new
container runs its startup checks, so deploy outside office hours. Data in
`/srv/workflow` is untouched.

## Day to day

```bash
deploy/oci/ops.sh status    # are both containers up?
deploy/oci/ops.sh logs      # follow the app's logs
```

Ubuntu installs security updates automatically (`unattended-upgrades`). Reboot
now and then when it asks (`/var/run/reboot-required`); the containers come
back on their own.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser can't connect at all | Step 3 rules on the *public* subnet's security list; `sudo iptables -L INPUT -n` shows ACCEPT for 80/443 above the REJECT. |
| Certificate error / Caddy logs ACME failures | DNS (step 6) must point at this VM, and port 80 must be open. `docker compose -f deploy/oci/compose.yaml logs caddy` |
| `deploy.sh` says not healthy | It prints the app logs. A missing secret or a bad `DATABASE_URL` shows up there. |
| "Out of capacity" creating the VM | Another availability domain, or retry later. |

## Without a database server

`DB_PROVIDER="sqlite"` with `DATABASE_URL="file:/data/workflow.db"` keeps the
database as a file in `/srv/workflow/data` instead. Changing `DB_PROVIDER`
needs a rebuild, which `deploy.sh` does.
