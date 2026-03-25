import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET_COUNT = 4000;
const BATCH_SIZE = 20; // 20 pages per request
const REQUEST_DELAY_MS = 1000; // 1 second delay between batches is very polite
const RATE_LIMIT_BACKOFF_MS = 10000;
const OUTPUT_PATHS = [
  path.join(process.cwd(), "public", "wikipedia-random-cache.json"),
  path.join(process.cwd(), "src", "data", "wikipedia-random-cache.json"),
];

const pages = [];
const seenTitles = new Set();
let requestCount = 0;

console.log(`Starting batch fetch for ${TARGET_COUNT} Wikipedia pages...`);

while (pages.length < TARGET_COUNT) {
  requestCount += 1;

  try {
    const batch = await fetchRandomBatch();

    for (const page of batch) {
      if (pages.length >= TARGET_COUNT) break;

      const titleKey = normalizeKey(page.title);

      if (!titleKey || seenTitles.has(titleKey) || !isCacheable(page)) {
        continue;
      }

      seenTitles.add(titleKey);
      pages.push(formatForGame(page));
    }

    console.log(
      `Cached ${pages.length}/${TARGET_COUNT} pages after ${requestCount} batch requests`,
    );

    await delay(REQUEST_DELAY_MS);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown fetch failure";
    console.error(`Batch request ${requestCount} failed: ${message}`);

    if (message.includes("429") || message.includes("403")) {
      console.error(`Rate limited; backing off for ${RATE_LIMIT_BACKOFF_MS}ms`);
      await delay(RATE_LIMIT_BACKOFF_MS);
    } else {
      await delay(REQUEST_DELAY_MS);
    }
  }
}

const payload = JSON.stringify(
  {
    createdAt: new Date().toISOString(),
    count: pages.length,
    pages,
  },
  null,
  2,
);

for (const outputPath of OUTPUT_PATHS) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, payload);
  console.log(` -> Wrote ${pages.length} cached pages to ${outputPath}`);
}

console.log("\nSuccess! Wikipedia cache refresh complete.");

async function fetchRandomBatch() {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2", // Returns arrays instead of weird object maps
    generator: "random",
    grnnamespace: "0", // Main articles only
    grnlimit: BATCH_SIZE.toString(),
    // Fetch intro text, page images, URLs, disambiguation flags, and short descriptions
    prop: "extracts|pageimages|info|pageprops|description",
    exintro: "1", // Only the lead section
    exsentences: "1",
    explaintext: "1", // Plain text, no HTML
    inprop: "url", // Gives us the canonicalurl
    pithumbsize: "320", // Size for thumbnails
  });

  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "llm-jeopardy/0.2 (batch cache builder; your-email@example.com)",
    },
  });

  if (!response.ok) {
    throw new Error(`Wikipedia Action API failed: ${response.status}`);
  }

  const data = await response.json();
  return data.query?.pages || [];
}

function isCacheable(page) {
  // Reject disambiguation pages and stubs with no text
  const isDisambiguation = page.pageprops && "disambiguation" in page.pageprops;

  return Boolean(
    page &&
    typeof page.title === "string" &&
    typeof page.extract === "string" &&
    page.extract.trim().length > 50 &&
    !isDisambiguation &&
    typeof page.canonicalurl === "string",
  );
}

function formatForGame(page) {
  // Map the Action API response to the exact shape the game engine expects
  return {
    title: page.title,
    extract: page.extract,
    description: page.description || undefined,
    type: "standard",
    content_urls: {
      desktop: {
        page: page.canonicalurl,
      },
    },
    thumbnail: page.thumbnail || undefined,
  };
}

function normalizeKey(title) {
  return typeof title === "string" ? title.trim().toUpperCase() : "";
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
