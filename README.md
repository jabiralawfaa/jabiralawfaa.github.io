# Portfolio — Rusydi Jabir Al-awfa

Portofolio statis (Astro + Tailwind v4) yang di-host di **GitHub Pages**, dengan konten yang bisa diedit lewat **Pages CMS** — tanpa server, tanpa biaya.

## Struktur

```
src/
  data/        ← SEMUA konten situs (JSON) — diedit via Pages CMS
    site.json        meta, navigasi, footer
    hero.json        seksi 01
    about.json       seksi 02
    projects.json    seksi 03 (proyek, album, poster)
    stack.json       seksi 04 (teknologi + marquee)
    design.json      seksi 05 (galeri visual)
    lab.json         seksi 06 (eksperimen)
    research.json    seksi 07 (riset akademik)
    experience.json  seksi 08 (timeline)
    toolkit.json     seksi 09 (kapabilitas)
    contact.json     seksi 10 (kontak + sosial)
  layouts/     BaseLayout.astro (head, header, footer)
  pages/       index.astro + 404.astro
  styles/      global.css (Tailwind v4 + gaya editorial)
public/        favicon.svg, .nojekyll, img/ (upload media CMS)
.pages.yml     skema editor Pages CMS
.github/workflows/deploy.yml   build & deploy otomatis
```

## Edit konten lewat Pages CMS

1. Buka **https://app.pagescms.org** dan sign in dengan GitHub.
2. Pilih repo `jabiralawfaa/jabiralawfaa.github.io`.
3. Edit konten lewat form — teks, gambar, tahun, link.
4. Klik **Save** → CMS commit ke `main` → GitHub Actions build & deploy otomatis (~1–2 menit).

Upload gambar dari CMS otomatis tersimpan di `public/img` dan ikut ter-deploy.

## Perintah lokal

| Perintah           | Fungsi                              |
| ------------------ | ----------------------------------- |
| `npm install`      | Pasang dependensi                   |
| `npm run dev`      | Server dev di `localhost:4321`      |
| `npm run build`    | Build produksi ke `dist/`           |
| `npm run preview`  | Preview hasil build                 |

## Deploy

Otomatis: setiap push/commit ke `main` memicu workflow **Deploy to GitHub Pages** (lihat tab *Actions* di repo untuk status).

Pastikan di repo: **Settings → Pages → Source = GitHub Actions**.

## Catatan teknis

- Tailwind v4 dikompilasi saat build (bukan CDN) — CSS produksi ±24 KB.
- `.nojekyll` menonaktifkan pemrosesan Jekyll agar deploy lebih cepat.
- Konten berada di `src/data/*.json`; `index.astro` hanya kerangka tampilan.
- Skema editor lengkap ada di `.pages.yml`; ubah di sana bila struktur data berubah.
