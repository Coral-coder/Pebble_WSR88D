# Store / listing assets

These images are **not** bundled into the `.pbw` — they are for the appstore
listing (and the project README). A watchface only shows a preview in the
Pebble app once it has a published listing with screenshots uploaded; a
sideloaded `.pbw` has no listing, so it shows no preview. The only image inside
the app itself is the 25×25 launcher menu icon (`../resources/images/icon.png`).

| File | Size | Use |
|---|---|---|
| `icon.png` | 25×25 | launcher menu icon (mirror of the bundled resource) |
| `screenshot-emery.png` | 200×228 | Pebble Time 2 screenshot |
| `screenshot-basalt.png` | 144×168 | Time / Time Steel screenshot |
| `screenshot-chalk.png` | 180×180 | Time Round screenshot (round) |
| `screenshot-diorite.png` | 144×168 | Pebble 2 screenshot (B/W radar) |
| `banner.png` | 720×320 | marketing banner (optional for watchfaces) |

Screenshots are at each platform's native screen resolution. Regenerate them
with `python3 store/mockup.py` (requires Pillow).

## Publishing (so it gets a preview like other faces)

1. Build the `.pbw` (CI attaches it to each release, or run `pebble build`).
2. Go to the **Rebble Developer Portal** (<https://dev-portal.rebble.io/>),
   create a *watchface* listing, and upload the `.pbw`.
3. Upload one screenshot per supported platform from this folder, and
   optionally `banner.png`.
4. Submit per the portal instructions. Once live, the Pebble app shows the
   uploaded screenshots as the preview.
