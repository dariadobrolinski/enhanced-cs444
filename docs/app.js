async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderItemCard(item, dateStr) {
  const tag = item.href ? "a" : "div";
  const hrefAttr = item.href ? `href="${item.href}" target="_blank" rel="noopener"` : "";
  const label = item.toneLabel
    ? `<span class="tag${item.tone === "urgent" ? " tag-urgent" : ""}">${escapeHtml(item.toneLabel)}</span><br>`
    : "";
  const dateLabel = dateStr ? `<span class="item-date">${escapeHtml(formatShortDate(dateStr))}</span>` : "";
  return `<${tag} class="item-card tone-${item.tone}${item.href ? "" : " no-link"}" ${hrefAttr}>
    ${label}${dateLabel}
    <div class="item-text">${escapeHtml(item.text)}</div>
  </${tag}>`;
}

// Groups items that reference the same assignment/chapter, e.g. "hw0" and
// "crude_wc.c used in hw0" both mention hw0, so they get boxed together
// instead of sitting as two unrelated lines.
const GROUP_KEY_RE = /\b(hw|proj|ch)-?(\d+)\b/i;
function extractGroupKey(item) {
  const m = GROUP_KEY_RE.exec(`${item.text} ${item.href || ""}`);
  return m ? `${m[1].toLowerCase()}${m[2]}` : null;
}

// Every item with a group key gets boxed under that key's label, even if
// it's currently the only one — e.g. hw1 has older posts archived away, but
// the one current hw1 item still gets an "HW1" box so the UI is consistent
// whether an assignment has one post or several.
function groupItems(items) {
  const byKey = new Map();
  for (const it of items) {
    const key = extractGroupKey(it);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }

  const blocks = [];
  const addedKeys = new Set();
  for (const it of items) {
    const key = extractGroupKey(it);
    if (key) {
      if (addedKeys.has(key)) continue;
      addedKeys.add(key);
      blocks.push({ type: "group", key, items: byKey.get(key) });
    } else {
      blocks.push({ type: "single", item: it });
    }
  }

  // She just appends new posts further down her page, so a higher `order`
  // means posted more recently. Show newest first, but keep each group's
  // own items in the order they were found (corrections already sit above
  // the older version they replace).
  const blockOrder = (b) => (b.type === "single" ? b.item.order : Math.max(...b.items.map((i) => i.order)));
  blocks.sort((a, b) => blockOrder(b) - blockOrder(a));
  return blocks;
}

function formatShortDate(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// itemDates: optional Map of item.id -> "YYYY-MM-DD", used to show when a
// lecture/chapter was actually taught (looked up from the Schedule tab's data).
function renderBlocks(items, itemDates) {
  return groupItems(items).map((b) => {
    if (b.type === "single") return renderItemCard(b.item, itemDates && itemDates.get(b.item.id));
    const date = itemDates && itemDates.get(b.items[0].id);
    const dateLabel = date ? ` <span class="group-date">· ${escapeHtml(formatShortDate(date))}</span>` : "";
    return `<div class="group">
      <div class="group-label">${escapeHtml(b.key)}${dateLabel}</div>
      <div class="group-items">${b.items.map((it) => renderItemCard(it)).join("")}</div>
    </div>`;
  }).join("");
}

function renderList(items, itemDates) {
  if (!items.length) return `<div class="empty-state">Nothing here.</div>`;
  return `<div class="item-list">${renderBlocks(items, itemDates)}</div>`;
}

function renderCollapsible(key, label, items, itemDates) {
  if (!items.length) return "";
  return `<button class="minor-toggle" type="button" data-toggle="${key}">${label} (${items.length})</button>
    <div class="minor-list" data-panel="${key}">${renderList(items, itemDates)}</div>`;
}

// Items are split three ways: current content up top; superseded/older
// versions (she reposts hw with corrections and leaves the old link up)
// tucked into an "Archived" dropdown; and in-class terminal-demo links
// (cat z0.txt, ls -la, ...) tucked into their own dropdown. Keeps the main
// view to just what's actually current and worth reading.
function renderListWithArchive(items, itemDates) {
  const main = items.filter((it) => !it.minor && it.tone !== "stale");
  const archived = items.filter((it) => it.tone === "stale" && !it.minor);
  const minor = items.filter((it) => it.minor);
  let html = renderList(main, itemDates);
  html += renderCollapsible("archived", "Archived (older versions)", archived, itemDates);
  html += renderCollapsible("demo", "In-class demo links", minor, itemDates);
  return html;
}

function renderCategory(data, category, itemDates) {
  const items = data.items.filter((it) => it.category === category);
  return renderListWithArchive(items, itemDates);
}

// Maps "ch1", "ch2", etc. to the earliest date that chapter shows up as
// reading/topic in the Schedule.
function buildChapterDates(schedule) {
  const map = new Map();
  for (const week of schedule.weeks) {
    for (const s of week.sessions) {
      const text = `${s.reading || ""} ${s.topic || ""}`;
      for (const m of text.matchAll(/\bch(\d+)\b/gi)) {
        const key = `ch${m[1]}`;
        if (!map.has(key)) map.set(key, s.date);
      }
    }
  }
  return map;
}

// Not every slide/lecture item mentions a chapter number in its own text
// (e.g. "Lesson plan, Week1, Day1" or the Huffman slides) — this fills in
// those gaps: "Week<n>, Day<n>" is resolved directly against the schedule's
// week/session structure, and a few named topics are matched by keyword
// against what the schedule's reading/topic/activities text says that day.
const NAMED_TOPIC_KEYWORDS = ["huffman"];
function findDateForItem(item, schedule, chapterDates) {
  const key = extractGroupKey(item);
  if (key && key.startsWith("ch") && chapterDates.has(key)) return chapterDates.get(key);

  const weekDay = /week\s*(\d+)\D+day\s*(\d+)/i.exec(item.text);
  if (weekDay) {
    const week = schedule.weeks[Number(weekDay[1]) - 1];
    const session = week && week.sessions[Number(weekDay[2]) - 1];
    if (session) return session.date;
  }

  const lowerText = item.text.toLowerCase();
  const keyword = NAMED_TOPIC_KEYWORDS.find((k) => lowerText.includes(k));
  if (keyword) {
    for (const week of schedule.weeks) {
      for (const s of week.sessions) {
        const sessionText = `${s.reading || ""} ${s.topic || ""} ${(s.activities || []).join(" ")}`.toLowerCase();
        if (sessionText.includes(keyword)) return s.date;
      }
    }
  }

  return null;
}

function buildItemDates(items, schedule) {
  const chapterDates = buildChapterDates(schedule);
  const map = new Map();
  for (const it of items) {
    const date = findDateForItem(it, schedule, chapterDates);
    if (date) map.set(it.id, date);
  }
  return map;
}

function renderBanner(data) {
  const slot = document.getElementById("banner-slot");
  if (!data.syllabusChanged) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = `<div class="banner"><div class="banner-inner">
    The syllabus PDF changed since the Schedule and Syllabus tabs were last hand-checked.
    <a href="${data.syllabus.href}" target="_blank" rel="noopener">Open the new syllabus</a> —
    those tabs may be a bit out of date until it's reviewed.
  </div></div>`;
}

function renderSchedule(schedule) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // "Current" week = the week holding the next upcoming (or today's) class.
  // Once the term is over, fall back to the last week so it still lands
  // somewhere sensible instead of scrolling nowhere.
  let currentWeekNum = null;
  outer: for (const week of schedule.weeks) {
    for (const s of week.sessions) {
      if (new Date(s.date + "T00:00:00").getTime() >= today.getTime()) {
        currentWeekNum = week.week;
        break outer;
      }
    }
  }
  if (currentWeekNum === null && schedule.weeks.length) {
    currentWeekNum = schedule.weeks[schedule.weeks.length - 1].week;
  }

  const parts = [];
  parts.push(`<div class="schedule-meta">${escapeHtml(schedule.term)} · ${escapeHtml(schedule.course)}<br>Syllabus revision: ${escapeHtml(schedule.syllabusRevision)}</div>`);

  for (const week of schedule.weeks) {
    const isCurrent = week.week === currentWeekNum;
    const weekAnchor = isCurrent ? ` id="current-week"` : "";
    parts.push(`<div class="week-block" data-week="${week.week}"${weekAnchor}>`);
    parts.push(`<button class="week-toggle${isCurrent ? " is-open" : ""}" type="button" data-toggle="week-${week.week}">Week ${week.week}</button>`);
    parts.push(`<div class="week-body${isCurrent ? " open" : ""}">`);
    for (const s of week.sessions) {
      const sessionDate = new Date(s.date + "T00:00:00");
      const isToday = sessionDate.getTime() === today.getTime();
      const isPast = sessionDate.getTime() < today.getTime();
      const anchor = isToday ? ` id="today-session"` : "";

      const postDue = (s.postDue || []).map((p) => `<span>${escapeHtml(p)}</span>`).join("");
      const activities = (s.activities || []).map((a) => `<li>${escapeHtml(a)}</li>`).join("");

      parts.push(`<div class="session-card${isToday ? " is-today" : ""}${isPast ? " is-past" : ""}"${anchor}>
        <div class="session-head">
          <div>
            <div class="session-date">${s.classNum ? `#${s.classNum} · ` : ""}${escapeHtml(s.label)}</div>
            <div class="session-topic">${escapeHtml(s.topic || "")}</div>
          </div>
          ${isToday ? '<span class="today-chip">Today</span>' : ""}
        </div>
        ${s.reading ? `<div class="reading-line">Reading: ${escapeHtml(s.reading)}</div>` : ""}
        ${postDue ? `<div class="post-due">${postDue}</div>` : ""}
        ${activities ? `<ul class="activities">${activities}</ul>` : ""}
      </div>`);
    }
    parts.push(`</div>`); // .week-body
    parts.push(`</div>`); // .week-block
  }

  return parts.join("\n");
}

// Turns plain-text emails, phone numbers, and bare domains (e.g.
// "portal.cs.umb.edu", "umb.edu/here4U") into real links, without needing
// the syllabus JSON itself to carry raw HTML.
const LINKIFY_RE = /([\w.+-]+@[\w-]+\.[\w.-]+)|(\d{3}[-.]\d{3}[-.]\d{4})|((?:[a-z0-9-]+\.)+(?:com|edu|org|net)(?:\/[^\s),]*)?)/gi;
function linkify(text) {
  return escapeHtml(text).replace(LINKIFY_RE, (match, email, phone, domain) => {
    if (email) return `<a href="mailto:${email}">${email}</a>`;
    if (phone) return `<a href="tel:+1${phone.replace(/[-.]/g, "")}">${phone}</a>`;
    if (domain) return `<a href="https://${domain}" target="_blank" rel="noopener">${domain}</a>`;
    return match;
  });
}

function renderSyllabusSection(section) {
  const parts = [`<h2>${escapeHtml(section.heading)}</h2>`];

  if (section.type === "fields") {
    parts.push(`<dl class="syllabus-fields">`);
    for (const f of section.fields) {
      parts.push(`<div class="syllabus-field"><dt>${escapeHtml(f.label)}</dt><dd>${linkify(f.value)}</dd></div>`);
    }
    parts.push(`</dl>`);
  } else if (section.type === "list") {
    if (section.intro) parts.push(`<p class="syllabus-intro">${escapeHtml(section.intro)}</p>`);
    parts.push(`<ul class="syllabus-list">${section.items.map((i) => `<li>${linkify(i)}</li>`).join("")}</ul>`);
    if (section.note) parts.push(`<p class="syllabus-note">${escapeHtml(section.note)}</p>`);
  } else if (section.type === "table") {
    parts.push(`<table class="syllabus-table"><tbody>`);
    for (const [a, b] of section.rows) {
      parts.push(`<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }

  return `<div class="syllabus-section">${parts.join("\n")}</div>`;
}

function renderSyllabus(syllabus, syllabusHref) {
  const parts = [];
  parts.push(`<div class="schedule-meta">Revision: ${escapeHtml(syllabus.revision)}<br>${escapeHtml(syllabus.sourceNote)}</div>`);
  if (syllabus.revisionNote) {
    parts.push(`<p class="syllabus-note" style="margin-top:-6px;">${escapeHtml(syllabus.revisionNote)}</p>`);
  }
  parts.push(syllabus.sections.map(renderSyllabusSection).join(""));
  if (syllabusHref) {
    parts.push(`<p class="syllabus-source-link"><a href="${syllabusHref}" target="_blank" rel="noopener">Open her original syllabus PDF →</a></p>`);
  }
  return parts.join("\n");
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${tabName}`);
  });
  try { localStorage.setItem("cs444-active-tab", tabName); } catch {}

  // Land on the current week every time Schedule is opened, but don't fight
  // the user's own scrolling afterward — free to scroll up for past weeks
  // or down for future ones.
  if (tabName === "schedule") {
    const target = document.getElementById("current-week");
    if (target) target.scrollIntoView({ block: "start" });
  }
}

async function main() {
  let data, schedule, syllabus;
  try {
    [data, schedule, syllabus] = await Promise.all([
      loadJSON("data.json"),
      loadJSON("schedule.json"),
      loadJSON("syllabus.json"),
    ]);
  } catch (e) {
    document.getElementById("app").innerHTML = `<div class="empty-state">Couldn't load course data. Try refreshing in a bit.</div>`;
    console.error(e);
    return;
  }

  const slideItems = data.items.filter((it) => it.category === "slides");
  const slideDates = buildItemDates(slideItems, schedule);

  document.getElementById("panel-homework").innerHTML = renderCategory(data, "homework");
  document.getElementById("panel-slides").innerHTML = renderCategory(data, "slides", slideDates);
  document.getElementById("panel-resources").innerHTML = renderCategory(data, "resources");
  document.getElementById("panel-schedule").innerHTML = renderSchedule(schedule);
  document.getElementById("panel-syllabus").innerHTML = renderSyllabus(syllabus, data.syllabus?.href);

  renderBanner(data);

  document.getElementById("scraped-at").textContent = new Date(data.scrapedAt).toLocaleString();
  document.getElementById("source-link").href = data.sourceUrl;

  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    setActiveTab(btn.dataset.tab);
  });

  document.getElementById("app").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-toggle]");
    if (!btn) return;
    const list = btn.nextElementSibling;
    const open = list.classList.toggle("open");
    btn.classList.toggle("is-open", open);
  });

  let startTab = "schedule";
  try { startTab = localStorage.getItem("cs444-active-tab") || "schedule"; } catch {}
  setActiveTab(startTab);
}

main();
