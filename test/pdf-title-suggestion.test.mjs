import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  getCaptionResults,
  getPdfTitleSuggestion,
} from "../lambda/index.mjs";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.PDF_TITLE_SUGGESTION_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) {
    delete process.env.PDF_TITLE_SUGGESTION_URL;
  } else {
    process.env.PDF_TITLE_SUGGESTION_URL = originalUrl;
  }
});

function configureEndpoint() {
  process.env.PDF_TITLE_SUGGESTION_URL =
    "https://ally.example/api/v2/clients/{clientId}/courses/{courseId}/pdf/title/{fileId}/suggestion?lang={lang}";
}

function makeItem(overrides = {}) {
  return {
    externalId: "file-1",
    fileType: "pdf",
    name: "course/report.pdf",
    ...overrides,
  };
}

test("requests a title with the selected language and bearer token", async () => {
  configureEndpoint();
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ text: "Annual Report" }) };
  };

  const result = await getPdfTitleSuggestion(
    "client-1",
    "course-1",
    makeItem(),
    "test-token",
    "fr-CA",
  );

  assert.equal(
    request.url,
    "https://ally.example/api/v2/clients/client-1/courses/course-1/pdf/title/file-1/suggestion?lang=fr-CA",
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.authorization, "Bearer test-token");
  assert.equal(request.options.body, undefined);
  assert.equal(result.status, "suggested");
  assert.equal(result.suggestion, "Annual Report");
});

test("does not request a title when the content already has one", async () => {
  configureEndpoint();
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error("fetch should not be called");
  };

  const result = await getPdfTitleSuggestion(
    "client-1",
    "course-1",
    makeItem({ title: "Existing title" }),
    "test-token",
    "en",
  );

  assert.equal(requestCount, 0);
  assert.equal(result.status, "skipped_existing_title");
  assert.equal(result.existingTitle, "Existing title");
});

test("records an untagged PDF as an expected outcome", async () => {
  configureEndpoint();
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ reason: "NotTagged" }),
  });

  const result = await getPdfTitleSuggestion(
    "client-1",
    "course-1",
    makeItem(),
    "test-token",
    "en",
  );

  assert.equal(result.status, "not_tagged");
});

test("records no available suggestion without failing the course run", async () => {
  configureEndpoint();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  const result = await getPdfTitleSuggestion(
    "client-1",
    "course-1",
    makeItem(),
    "test-token",
    "en",
  );

  assert.equal(result.status, "no_suggestion");
  assert.equal(result.suggestion, "");
});

test("can omit PDFs on repeated label passes", async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error("PDF suggestion request should be skipped");
  };

  const result = await getCaptionResults(
    "client-1",
    "course-1",
    "test-token",
    [makeItem()],
    "Language",
    "en",
    false,
  );

  assert.equal(requestCount, 0);
  assert.deepEqual(result, { captions: [], pdfs: [] });
});

test("identifies a rejected image caption request without exposing its token", async () => {
  const originalCaptionUrl = process.env.CAPTION_SUGGESTION_URL;
  process.env.CAPTION_SUGGESTION_URL =
    "https://ally.example/clients/{clientId}/courses/{courseId}/files/{fileId}/suggestion?lang={lang}";
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => "The request contains bad syntax or cannot be fulfilled.",
  });

  try {
    await assert.rejects(
      getCaptionResults(
        "client-1",
        "course-1",
        "private-test-token",
        [makeItem({ fileType: "image", name: "equation.png" })],
        "Math",
        "en",
        true,
      ),
      (error) => {
        assert.match(error.message, /fileId=file-1/);
        assert.match(error.message, /name="equation.png"/);
        assert.match(error.message, /fileType=image, lang=en, label=Math, status=400/);
        assert.ok(!error.message.includes("private-test-token"));
        return true;
      },
    );
  } finally {
    if (originalCaptionUrl === undefined) {
      delete process.env.CAPTION_SUGGESTION_URL;
    } else {
      process.env.CAPTION_SUGGESTION_URL = originalCaptionUrl;
    }
  }
});