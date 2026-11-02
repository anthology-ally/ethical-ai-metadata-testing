const getCaptionSuggestionUrl = (clientId, courseId, fileId, lang) =>
  process.env.CAPTION_SUGGESTION_URL.replace("{courseId}", courseId)
    .replace("{clientId}", clientId)
    .replace("{fileId}", fileId)
    .replace("{lang}", encodeURIComponent(lang));

const getContentUrl = (clientId, courseId) =>
  process.env.GET_CONTENT_URL.replace("{courseId}", courseId).replace(
    "{clientId}",
    clientId,
  );

const getPdfFileDownloadUrl = (clientId, courseId, fileId) =>
  process.env.GET_PDF_CONTENT_URL.replace("{courseId}", courseId)
    .replace("{clientId}", clientId)
    .replace("{fileId}", fileId);

const getDocumentContentUrl = (clientId, courseId, fileId) =>
  process.env.GET_DOCUMENT_CONTENT_URL.replace("{courseId}", courseId)
    .replace("{clientId}", clientId)
    .replace("{fileId}", fileId);

import { extractImagesWithPrecedingText } from "./pdf-extractor.js";

async function getPdfCaptionSuggestions(clientId, courseId, fileId, token, lang) {
  const url = getPdfFileDownloadUrl(clientId, courseId, fileId);
  const embedInfo = await fetch(url, {
    method: "GET",
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9,cs;q=0.8",
      authorization: `Bearer ${token}`,
    },
  });

  if (!embedInfo.ok) return { error: embedInfo.status };

  const embedJson = await embedInfo.json();
  const pdfUrl = embedJson?.urls?.pdf;
  if (!pdfUrl)
    return { error: 404, message: "PDF URL not found in embed info" };

  const pdfData = await extractImagesWithPrecedingText(pdfUrl);
  const captions = [];
  for (const imageData of pdfData) {
    const pdfCaptionSuggestionUrl =
      process.env.PDF_CAPTION_SUGGESTION_URL.replace("{courseId}", courseId)
        .replace("{clientId}", clientId)
        .replace("{fileId}", fileId)
        .replace("{figureIndex}", imageData.index)
        .replace("{lang}", encodeURIComponent(lang));

    const res = await fetch(pdfCaptionSuggestionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9,cs;q=0.8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ context: imageData.text }),
    });

    if (!res.ok)
      return { error: res.status, message: await res.text() };
    const json = await res.json();
    if (typeof json.text !== "string" || !json.text.trim())
      return {
        error: 502,
        message: `Caption service returned empty text for figure ${imageData.index}`,
      };
    captions.push({ figureIndex: imageData.index, suggestion: json.text });
  }

  return captions;
}

export async function getPdfTitleSuggestion(clientId, courseId, item, token, lang) {
  const existingTitle = typeof item.title === "string" ? item.title.trim() : "";
  if (existingTitle) {
    return {
      type: "title",
      language: lang,
      existingTitle,
      suggestion: "",
      status: "skipped_existing_title",
    };
  }

  const url = process.env.PDF_TITLE_SUGGESTION_URL
    .replace("{courseId}", courseId)
    .replace("{clientId}", clientId)
    .replace("{fileId}", item.externalId)
    .replace("{lang}", encodeURIComponent(lang));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "*/*",
      authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) return { error: res.status };
  const json = await res.json();
  if (json?.reason === "NotTagged") {
    return {
      type: "title",
      language: lang,
      existingTitle: "",
      suggestion: "",
      status: "not_tagged",
    };
  }
  const suggestion = typeof json?.text === "string" ? json.text.trim() : "";
  if (!suggestion) {
    return {
      type: "title",
      language: lang,
      existingTitle: "",
      suggestion: "",
      status: "no_suggestion",
    };
  }

  return {
    type: "title",
    language: lang,
    existingTitle: "",
    suggestion: suggestion.trim(),
    status: "suggested",
  };
}

async function getCaptionSuggestion(
  clientId,
  courseId,
  fileId,
  fileType,
  token,
  lang,
) {
  const captions = [];
  if (fileType === "image") {
    const url = getCaptionSuggestionUrl(clientId, courseId, fileId, lang);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9,cs;q=0.8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    if (!res.ok)
      return { error: res.status, message: await res.text() };
    const json = await res.json();
    if (typeof json.text !== "string" || !json.text.trim())
      return { error: 502, message: "Caption service returned empty text" };
    captions.push(json.text);

    return captions;
  }

  if (fileType === "pdf") {
    return getPdfCaptionSuggestions(clientId, courseId, fileId, token, lang);
  }

  if (fileType === "application/x-document") {
    const url = getDocumentContentUrl(clientId, courseId, fileId);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9,cs;q=0.8",
        authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) return { error: res.status };
    if (res.headers.get("content-type")?.includes("application/json")) {
      await res.json();
    } else if (res.headers.get("content-type")?.includes("text/html")) {
      await res.text();
    } else {
      await res.arrayBuffer();
    }
    return captions;
  }
}

async function getAvailableContent(clientId, courseId, token) {
  const res = await fetch(getContentUrl(clientId, courseId), {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { error: res.status };
  }
  const json = await res.json();
  return json.content;
}

export async function getCaptionResults(clientId, courseId, token, data, label, lang, includePdfs) {
  const results = await Promise.all(
    data.map(async (item) => {
      const name = `${label}/${item.name}`;
      if (item.fileType === "pdf") {
        if (!includePdfs) return { captions: [], pdfs: [] };

        const [figureSuggestions, titleResult] = await Promise.all([
          getPdfCaptionSuggestions(clientId, courseId, item.externalId, token, lang),
          getPdfTitleSuggestion(clientId, courseId, item, token, lang),
        ]);
        if (figureSuggestions?.error || titleResult?.error) {
          const error = figureSuggestions?.error ? figureSuggestions : titleResult;
          throw new Error(
            `PDF suggestion request failed (clientId=${clientId}, courseId=${courseId}, fileId=${item.externalId}, label=${label}, status=${error.error}): ${error.message || "PDF suggestion request failed"}`,
          );
        }
        return {
          captions: [],
          pdfs: [
            ...figureSuggestions.map(({ figureIndex, suggestion }) => ({
              name,
              type: "alt-text",
              language: lang,
              figureIndex,
              existingTitle: "",
              suggestion,
              status: "suggested",
            })),
            { name, ...titleResult },
          ],
        };
      }

      const captions = await getCaptionSuggestion(
        clientId,
        courseId,
        item.externalId,
        item.fileType,
        token,
        lang,
      );
      if (captions?.error)
        throw new Error(
          `Caption request failed (clientId=${clientId}, courseId=${courseId}, fileId=${item.externalId}, name=${JSON.stringify(item.name)}, fileType=${item.fileType}, lang=${lang}, label=${label}, status=${captions.error}): ${captions.message || "Caption service request failed"}`,
        );
      return {
        captions: captions.map((caption) => ({ name, caption })),
        pdfs: [],
      };
    }),
  );

  return {
    captions: results.flatMap(({ captions }) => captions),
    pdfs: results.flatMap(({ pdfs }) => pdfs),
  };
}

export const handler = async (event) => {
  const {
    clientId,
    courseId,
    label,
    lang = "en",
    includePdfs = "true",
  } = event.queryStringParameters ?? {};
  const token = event.headers?.authorization?.replace(/^Bearer\s+/i, "");

  if (!courseId || !token || !label) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "courseId, label, and Authorization header are required",
      }),
    };
  }

  const content = await getAvailableContent(clientId, courseId, token);
  if (content?.error) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: `Failed to fetch content: ${content.error}`,
      }),
    };
  }

  let results;
  try {
    results = await getCaptionResults(
      clientId,
      courseId,
      token,
      content,
      label,
      lang,
      includePdfs.toLowerCase() !== "false",
    );
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
  const response = {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(results),
  };
  return response;
};
