const getCaptionSuggestionUrl = (clientId, courseId, fileId) =>
  process.env.CAPTION_SUGGESTION_URL.replace("{courseId}", courseId)
    .replace("{clientId}", clientId)
    .replace("{fileId}", fileId);

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

async function getPdfCaptionSuggestions(clientId, courseId, fileId, token) {
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
        .replace("{figureIndex}", imageData.index);

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
    captions.push(json.text);
  }

  return captions;
}

async function getCaptionSuggestion(
  clientId,
  courseId,
  fileId,
  fileType,
  token,
) {
  const captions = [];
  if (fileType === "image") {
    const url = getCaptionSuggestionUrl(clientId, courseId, fileId);

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
    return getPdfCaptionSuggestions(clientId, courseId, fileId, token);
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

async function getCaptionResults(clientId, courseId, token, data, label) {
  // Check content type to determine if pdf or image
  return Promise.all(
    data.map(async (item) => {
      const captions = await getCaptionSuggestion(
        clientId,
        courseId,
        item.externalId,
        item.fileType,
        token,
      );
      if (captions?.error)
        throw new Error(
          `Caption request failed (clientId=${clientId}, courseId=${courseId}, fileId=${item.externalId}, label=${label}, status=${captions.error}): ${captions.message || "Caption service request failed"}`,
        );
      return {
        name: `${label}/${item.name}`,
        caption: captions.join("|"),
      };
    }),
  );
}

export const handler = async (event) => {
  const { clientId, courseId, label } = event.queryStringParameters ?? {};
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
