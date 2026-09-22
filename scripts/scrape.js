// Scrapes the CS444 course page and regenerates docs/data.json.
// Also checks whether the syllabus PDF has changed (new filename/hash) and
// records that in the data so the site can flag "schedule may be outdated"
// without us trying to brittle-parse a hand-typeset PDF table on every run.

import * as cheerio from "cheerio";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const SITE_URL = "https://www.cs.umb.edu/~hdeblois/cs444/f26/";
const OUT_DIR = new URL("../docs/", import.meta.url);
const DATA_PATH = path.join(new URL(OUT_DIR).pathname, "data.json");

// Known meanings for the colors she uses, inferred from how they're applied
// on the page. Anything not in this map is treated as "normal".
const COLOR_MEANINGS = {
  "#227700": { label: "Lecture / slides", tone: "lecture" },
  "#ff0000": { label: "Important update or correction", tone: "urgent" },
  "#dd0000": { label: "Important update or correction", tone: "urgent" },
  "#990000": { label: "Superseded (older/delayed version)", tone: "stale" },
  "#990099": { label: "Superseded (older version)", tone: "stale" },
  "#0000ff": { label: "External textbook / reference", tone: "reference" },
};

// In-class terminal demos ("cat z0.txt", "ls -la", "hexdump -C z1.txt, w, top")
// aren't content to read — they're just command lists pointing at throwaway
// scratch files. Keep them out of the way instead of showing them as posts.
const MINOR_PATTERN = /^(cat |ls |ps |top\b|w\b|hexdump|pwd\b|cd )/i;

function isMinor(text) {
  return MINOR_PATTERN.test(text.trim());
}

function classify(text, href) {
  const t = text.toLowerCase();
  const h = (href || "").toLowerCase();

  if (t.includes("syllabus")) return "syllabus";
  if (/\bhw\d*\b/.test(t) || /^hw\d/.test(h) || t.includes("homework")) {
    return "homework";
  }
  if (/\bproj\d*\b/.test(t) || /^proj\d/.test(h)) {
    return "projects";
  }
  if (
    t.includes("lecture") ||
    t.includes("slides") ||
    t.includes("lesson plan") ||
    /^(ch\d+|444f26-lpwk)/.test(h)
  ) {
    return "slides";
  }
  return "resources";
}

function normalizeColor(style) {
  const m = /color:\s*(#[0-9a-fA-F]{3,6})/.exec(style || "");
  return m ? m[1].toLowerCase() : null;
}

async function scrapeHomepage() {
  const res = await fetch(SITE_URL, { headers: { "User-Agent": "cs444-tracker/1.0 (personal study aid)" } });
  if (!res.ok) throw new Error(`Failed to fetch homepage: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  let order = 0;
  $("p").each((i, el) => {
    const $p = $(el);
    // A paragraph can hold more than one <a> (e.g. "cat z0.txt" and
    // "cat z1.txt, ls -la, ..." sit in the same <p>) — grab all of them.
    $p.find("a").each((_, aEl) => {
      const $a = $(aEl);
      const href = ($a.attr("href") || "").trim();
      const text = $a.text().trim();
      if (!text) return;

      const color = normalizeColor($a.attr("style"));
      const meaning = color ? COLOR_MEANINGS[color] : null;
      const category = classify(text, href);
      const absoluteHref = href ? (href.startsWith("http") ? href : new URL(href, SITE_URL).toString()) : null;

      items.push({
        id: crypto.createHash("sha1").update((absoluteHref ?? "") + text).digest("hex").slice(0, 10),
        text,
        href: absoluteHref,
        color,
        tone: meaning?.tone ?? "normal",
        toneLabel: meaning?.label ?? null,
        category,
        minor: isMinor(text),
        order: order++,
      });
    });
  });

  return items;
}

async function checkSyllabus(items) {
  const syllabusItem = items.find((it) => it.category === "syllabus" && it.href);
  if (!syllabusItem) return null;

  const res = await fetch(syllabusItem.href, { headers: { "User-Agent": "cs444-tracker/1.0 (personal study aid)" } });
  if (!res.ok) return { href: syllabusItem.href, error: `fetch failed: ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash("sha1").update(buf).digest("hex");

  let revisionLine = null;
  try {
    const parsed = await pdfParse(buf);
    const firstLines = parsed.text.split("\n").slice(0, 6).join(" ");
    const m = /(\d{1,2}\s+\w+\s+\d{4}\s*Rev\d*)/i.exec(firstLines);
    revisionLine = m ? m[1] : null;
  } catch (e) {
    // Non-fatal — the PDF still gets linked even if text extraction fails.
  }

  return { href: syllabusItem.href, hash, revisionLine, checkedAt: new Date().toISOString() };
}

async function main() {
  await fs.mkdir(new URL(OUT_DIR), { recursive: true });

  let previous = null;
  try {
    previous = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
  } catch {
    // first run — no previous data
  }

  const items = await scrapeHomepage();
  const syllabus = await checkSyllabus(items);

  const syllabusChanged =
    previous?.syllabus?.hash && syllabus?.hash && previous.syllabus.hash !== syllabus.hash;

  const data = {
    scrapedAt: new Date().toISOString(),
    sourceUrl: SITE_URL,
    items,
    syllabus,
    syllabusChanged: Boolean(syllabusChanged),
    // Preserve the last time a human confirmed the hand-built schedule.json
    // still matches the syllabus, so the UI can show a "may be stale" badge.
    scheduleConfirmedFor: previous?.scheduleConfirmedFor ?? syllabus?.hash ?? null,
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote ${items.length} items to ${DATA_PATH}`);
  if (syllabusChanged) {
    console.log("NOTE: syllabus PDF hash changed since last scrape — schedule.json may need a manual re-check.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
