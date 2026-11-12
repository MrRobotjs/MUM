# Getting started with MUM

MUM is one program file. You don't need to install Python, Node.js, a database or Docker. Download the file for your computer, start it, and open the dashboard in your web browser.

| Your computer | File |
|---|---|
| Windows (64-bit) | `mum-windows-amd64.exe` |
| Linux (64-bit Intel/AMD) | `mum-linux-amd64` |
| Mac with Apple silicon (M1 or later) | `mum-macos-arm64` |

Prefer containers? See [Running with Docker](#running-with-docker).

## 1. Start MUM

### Windows

1. Put `mum-windows-amd64.exe` in a folder of your choice and double-click it.
2. The first time, Windows may show **"Windows protected your PC"**. MUM is not code-signed, so Windows doesn't recognise the publisher. Click **More info**, then **Run anyway**.
3. A console window opens and shows something like:

   ```text
   MUM dashboard: http://127.0.0.1:5699
   Data directory: C:\Users\you\AppData\Roaming\MUM
   ```

4. Open the dashboard address in your browser. Keep the window open while you use MUM.

If something stops MUM from starting, the window stays open with an explanation and closes when you press Enter.

### macOS

1. Double-click `mum-macos-arm64`. If it opens as a text file, open **Terminal** and run `chmod +x ~/Downloads/mum-macos-arm64`, then double-click it again. Change the path if you saved the file somewhere else.
2. macOS will say the app **can't be opened because Apple cannot check it**. MUM is not notarized. Open **System Settings → Privacy & Security**, scroll down to the message about `mum-macos-arm64` and click **Open Anyway**. Then start it again and confirm.
3. A Terminal window shows the dashboard address. Open it in your browser.

### Linux

```sh
chmod +x mum-linux-amd64
./mum-linux-amd64
```

Open the dashboard address it prints in your browser.

## 2. Finish setup

On the first visit, MUM opens the setup wizard. Create the owner account, then add your media servers. Until setup is finished, every page leads back to the wizard.

MUM works with **Plex, Jellyfin, Emby, Kavita, Audiobookshelf, Komga and RomM**. Support for each is built in; there is nothing to install. Features differ between servers, and the dashboard offers only what a server supports. Plugin archives made for the older Python version of MUM cannot be used.

## 3. Stop MUM

Press **Ctrl+C** in MUM's window. MUM finishes saving and exits. Closing the window also stops it, but Ctrl+C gives it more time to save.

## Where MUM keeps its data

| System | Default data folder |
|---|---|
| Windows | `%AppData%\MUM` (for example `C:\Users\you\AppData\Roaming\MUM`) |
| macOS | `~/Library/Application Support/MUM` |
| Linux | `~/.config/MUM` |

To use another folder, start MUM with `--data-dir "path/to/folder"` or set the `MUM_DATA_DIR` environment variable.

The folder contains:

- `mum.sqlite` (with `mum.sqlite-wal` and `mum.sqlite-shm`): the database.
- `mum-config.json`: network settings (see below).
- `invitation.key` and `plex.key`: encryption keys. **These cannot be recreated.** Without them, encrypted invitation links and Plex credentials are lost.
- `.mum.lock`: stops two copies of MUM from using the same folder. Leave it alone.

### Backups

1. Stop MUM.
2. Copy the **whole data folder** somewhere safe.
3. Start MUM again.

To restore, stop MUM and put the copied folder back. A copy of the database alone is not a complete backup, because the key files are needed too.

### Updating

1. Stop MUM and back up the data folder.
2. Replace the program file with the new version.
3. Start MUM. It updates the database automatically.

Don't go back to an older version with data from a newer one; MUM refuses to start in that case. Restore your backup instead.

### Locked out of the owner account

Stop MUM, then run this in a terminal and follow the prompts:

```sh
mum-windows-amd64.exe --recover-owner --data-dir "C:\Users\you\AppData\Roaming\MUM"
```

Use your own file name and data folder.

## Letting other people reach MUM

At first MUM only answers on the computer it runs on (`127.0.0.1:5699`). You choose how others reach it. Change the settings in `mum-config.json` in the data folder, then restart MUM:

```json
{
  "listen": "127.0.0.1:5699",
  "secure_cookies": false,
  "trusted_proxies": []
}
```

| Setting | What it does |
|---|---|
| `listen` | Address and port MUM listens on. `127.0.0.1:5699` = this computer only. `0.0.0.0:5699` = every network connection on this computer. |
| `secure_cookies` | `true` makes browsers send the login cookie over HTTPS only. Turn it on only if everyone uses an `https://` address, or logging in over plain `http://` will stop working. |
| `trusted_proxies` | IP addresses (or ranges like `172.16.0.0/12`) of reverse proxies that MUM should trust for the visitor's real address and for HTTPS. |

If the file contains a mistake, such as a misspelled setting, MUM refuses to start and names the file and the problem. Each setting can also be given when starting MUM, and that wins over the file: `--listen`, `--secure-cookies`, `--trusted-proxies`, or the environment variables `MUM_LISTEN`, `MUM_SECURE_COOKIES`, `MUM_TRUSTED_PROXIES`.

### Option A: your home network only

1. Set `"listen": "0.0.0.0:5699"` and restart MUM. It now prints `listening on all network interfaces`.
2. On Windows, allow MUM through the firewall when asked. Choose **Private networks**.
3. Others on your network open `http://<this computer's IP>:5699`, for example `http://192.168.1.20:5699`.

### Option B: port forwarding (reach MUM from the internet by IP or domain)

1. Do Option A first.
2. In your router, forward **TCP port 5699** to this computer's local IP address. Give the computer a fixed (reserved) IP so the forward keeps working.
3. People open `http://<your public IP or domain>:5699`.

Plain `http://` over the internet is **not encrypted**: passwords and invitation links can be read on the way. For anything beyond a quick test, use a reverse proxy with HTTPS (Option C).

### Option C: a reverse proxy with HTTPS (recommended for internet access)

A reverse proxy such as Caddy, nginx or Traefik gives MUM a proper `https://` address and certificate. Keep MUM's `listen` on `127.0.0.1:5699` when the proxy runs on the same computer, and list the proxy in `trusted_proxies`. MUM then sees each visitor's real address (for login rate limits) and knows the connection was HTTPS.

MUM needs its own domain or subdomain, such as `mum.example.com`. It cannot be served from a sub-path like `example.com/mum`.

**Caddy** (gets HTTPS certificates automatically). In the `Caddyfile`:

```text
mum.example.com {
	reverse_proxy 127.0.0.1:5699
}
```

**nginx** (inside a `server` block that already has your certificate):

```nginx
location / {
    proxy_pass http://127.0.0.1:5699;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    # Live updates use a WebSocket at /ws.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

`mum-config.json` for a proxy on the same computer:

```json
{
  "listen": "127.0.0.1:5699",
  "secure_cookies": true,
  "trusted_proxies": ["127.0.0.1"]
}
```

If the proxy runs on another machine, set `listen` to `0.0.0.0:5699` and put that machine's IP address in `trusted_proxies`. Make sure only the proxy can reach port 5699, for example with a firewall rule.

## Starting MUM automatically

- **Windows:** press **Win+R**, type `shell:startup` and press Enter. Put a shortcut to `mum-windows-amd64.exe` in the folder that opens. MUM then starts when you sign in.
- **Linux (systemd):** create `/etc/systemd/system/mum.service`. Adjust the user and paths:

  ```ini
  [Unit]
  Description=MUM dashboard
  After=network-online.target
  Wants=network-online.target

  [Service]
  User=mum
  ExecStart=/opt/mum/mum-linux-amd64 --data-dir /var/lib/mum
  Restart=on-failure
  TimeoutStopSec=30

  [Install]
  WantedBy=multi-user.target
  ```

  Then run `sudo systemctl enable --now mum`. Make sure the user owns `/var/lib/mum`.

## Running with Docker

Docker is optional. Use it if you already run your other services in containers.

**Using the published image** (`ghcr.io/mrrobotjs/mum`): copy the `docker-compose.yml` example from the project README, set `TZ`, run `docker compose up -d` and open `http://<docker host>:5699`. The data volume is `<folder name>_mum-data`; use that name in the backup commands below.

**Building from source** instead:

1. Download the MUM source code (on GitHub, use **Code → Download ZIP**, or `git clone`).
2. Edit the root `docker-compose.yml`: set `TZ` to your time zone. To use a different port, change the **left** number in `"5699:5699"`.
3. From the source folder, run:

   ```sh
   docker compose up -d --build
   ```

4. Open `http://<docker host>:5699` and finish setup.

Notes:

- Data lives in the Docker volume `mum-go_mum-data`. Inside the container MUM already listens on all interfaces; publish only the ports you need.
- Behind a reverse proxy container on the same Docker network, uncomment `MUM_TRUSTED_PROXIES` in the compose file, and `MUM_SECURE_COOKIES` if the site is HTTPS-only.
- Stop with `docker compose stop`. MUM gets 30 seconds to finish saving.
- The root Dockerfile builds both the frontend and Go app. Go and Node.js are only needed inside the build containers.
- A first Docker start uses its own data volume, separate from the executable's data folder. To keep your current Go setup, stop the executable and copy its whole data folder (including keys) into the volume before starting the container; never run both against the same folder.
- If the executable already uses port 5699, stop it first or publish another host port, such as `"5700:5699"`. Services running on the Docker host use `host.docker.internal` on Docker Desktop, rather than `localhost` inside the container.
- Update: back up first, download the new source code, then run the same `up -d --build` command again.

**Back up the volume** (from the source folder):

```sh
docker compose stop
docker run --rm -v mum-go_mum-data:/data -v "$PWD":/backup alpine tar czf /backup/mum-backup.tgz -C /data .
docker compose start
```

**Restore it** (this replaces the current data):

```sh
docker compose stop
docker run --rm -v mum-go_mum-data:/data -v "$PWD":/backup alpine sh -c "rm -rf /data/* /data/.mum.lock && tar xzf /backup/mum-backup.tgz -C /data && chown -R 1000:1000 /data"
docker compose start
```

On Windows PowerShell, replace `"$PWD"` with `"${PWD}"`.

## Console and Docker logs

The executable writes timestamped INFO, WARN and ERROR messages to its console. Docker captures the same output in its Logs tab. The supplied Compose files rotate container logs at 10 MB per file, retaining three files. Follow the output with:

```sh
docker compose logs -f mum
```

Logs include startup, monitoring configuration, poll session counts and changes, provider sync results, log persistence stalls/recovery and shutdown. Provider credentials and raw session payloads are omitted. For more detail, use `--log-level debug` with the executable, or set `MUM_LOG_LEVEL: debug` under the Compose service's `environment` and recreate it. Supported levels are `debug`, `info` (default), `warn` and `error`.

New active Plex, Jellyfin and Emby servers added by the owner use native WebSocket notifications for faster updates, with complete HTTP snapshots and polling every 30 seconds for recovery. The upgrade also selects sockets for already-enabled Plex monitors. Review or disable this under **Streams → Streaming Settings → Activity monitoring**. Existing monitoring choices stay intact; delegated additions require owner review. Changing server credentials or connection settings pauses monitoring until the owner saves the monitoring configuration again.

## Licence

MUM is free software under the GNU Affero General Public License v3.0; see `LICENSE`. Third-party licences are listed in `THIRD_PARTY_LICENSES.md` and the `licenses` folder that come with each release.
