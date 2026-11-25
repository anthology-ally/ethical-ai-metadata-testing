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
  console.log(`=== Fetching embedInfo ===`);
  console.log(`URL: ${url}`);
  console.log(`FileId: ${fileId}`);
  
  const embedInfo = await fetch(url, {
    method: "GET",
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9,cs;q=0.8",
      authorization: `Bearer ${token}`,
    },
  });

  console.log(`Response status: ${embedInfo.status} ${embedInfo.statusText}`);
  
  if (!embedInfo.ok) {
    const errorBody = await embedInfo.text();
    console.error(`ERROR: Status ${embedInfo.status}`);
    console.error(`Error response: ${errorBody?.substring(0, 500)}`);
    return { error: embedInfo.status, message: `HTTP ${embedInfo.status}: ${errorBody}` };
  }

  const embedJson = await embedInfo.json();
  console.log(`embedInfo response: ${JSON.stringify(embedJson)}`);
  console.log(`embedInfo status: ${embedJson.status}`);
  console.log(`embedInfo urls keys: ${Object.keys(embedJson.urls || {}).join(', ')}`);
  
  // Check if PDF conversion is complete (status can be "Done" or "Complete")
  const isComplete = embedJson.status === "Done" || embedJson.status === "Complete";
  if (!isComplete) {
    console.warn(`PDF not ready. Status: ${embedJson.status}`);
    return { 
      error: 503, 
      message: `PDF conversion in progress (status: ${embedJson.status}). Available URLs: ${Object.keys(embedJson.urls || {}).join(', ')}`
    };
  }
  
  // Try multiple common PDF URL paths
  const pdfUrl = embedJson?.urls?.pdf 
    || embedJson?.urls?.Pdf 
    || embedJson?.urls?.PDF
    || embedJson?.url 
    || embedJson?.pdfUrl 
    || embedJson?.pdf_url
    || embedJson?.downloadUrl
    || embedJson?.link
    || embedJson?.href
    || embedJson?.contentUrl
    || embedJson?.embed?.url;
  
  if (!pdfUrl) {
    console.error(`Failed to find PDF URL in embedInfo despite complete status.`);
    console.error(`Full response: ${JSON.stringify(embedJson, null, 2)}`);
    console.error(`URLs object: ${JSON.stringify(embedJson.urls, null, 2)}`);
    console.error(`Available URL keys: ${Object.keys(embedJson.urls || {}).join(', ')}`);
    
    return { 
      error: 404, 
      message: `PDF URL not found in embed info. Available URLs: ${Object.keys(embedJson.urls || {}).join(', ')}`
    };
  }

  const pdfData = await extractImagesWithPrecedingText(pdfUrl);
  console.log(`Extracted ${pdfData.length} images from PDF`);
  
  if (pdfData.length === 0) {
    console.warn(`No images found in PDF, returning empty captions`);
    return [];
  }
  
  const captions = [];
  for (const imageData of pdfData) {
    console.log(`Processing image: index=${imageData.index}, page=${imageData.page}, textLength=${imageData.text?.length || 0}`);
    
    if (!imageData.text) {
      console.warn(`Image at index ${imageData.index} has empty context, skipping`);
      continue;
    }

    const figureIndexRaw = String(imageData.index);
    const langEncoded = encodeURIComponent(lang);
    
    // Build URL carefully
    let pdfCaptionSuggestionUrl = process.env.PDF_CAPTION_SUGGESTION_URL;
    console.log(`Template URL: ${pdfCaptionSuggestionUrl}`);
    
    pdfCaptionSuggestionUrl = pdfCaptionSuggestionUrl.replace("{clientId}", clientId);
    console.log(`After clientId: ${pdfCaptionSuggestionUrl}`);
    
    pdfCaptionSuggestionUrl = pdfCaptionSuggestionUrl.replace("{courseId}", courseId);
    console.log(`After courseId: ${pdfCaptionSuggestionUrl}`);
    
    pdfCaptionSuggestionUrl = pdfCaptionSuggestionUrl.replace("{fileId}", fileId);
    console.log(`After fileId: ${pdfCaptionSuggestionUrl}`);
    
    pdfCaptionSuggestionUrl = pdfCaptionSuggestionUrl.replace("{figureIndex}", figureIndexRaw);
    console.log(`After figureIndex: ${pdfCaptionSuggestionUrl}`);
    
    pdfCaptionSuggestionUrl = pdfCaptionSuggestionUrl.replace("{lang}", langEncoded);
    console.log(`Final URL: ${pdfCaptionSuggestionUrl}`);

    const contextText = imageData.text.substring(0, 5000);
    const requestBody = { context: contextText };
    console.log(`Request body keys: ${Object.keys(requestBody).join(', ')}`);
    console.log(`Context length: ${contextText.length}`);
    
    const bodyJson = JSON.stringify(requestBody);
    console.log(`Request JSON length: ${bodyJson.length}`);
    console.log(`Request JSON valid: ${bodyJson.startsWith('{')}`);

    const res = await fetch(pdfCaptionSuggestionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9,cs;q=0.8",
        authorization: `Bearer ${token}`,
      },
      body: bodyJson,
    });

    console.log(`Caption request response status: ${res.status}`);
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Caption request FAILED`);
      console.error(`URL: ${pdfCaptionSuggestionUrl}`);
      console.error(`Status: ${res.status}`);
      console.error(`Response: ${errorText.substring(0, 1000)}`);
      return { error: res.status, message: `Caption request error: ${errorText}` };
    }
    
    const json = await res.json();
    console.log(`Caption response: ${JSON.stringify(json).substring(0, 200)}`);
    
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

  if (!res.ok) {
    const errorText = await res.text();
    return { error: res.status, message: `Title suggestion failed: ${errorText}` };
  }
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
  const url = getContentUrl(clientId, courseId);
  console.log(`=== Fetching Content ===`);
  console.log(`URL: ${url}`);
  console.log(`Client ID: ${clientId}`);
  console.log(`Course ID: ${courseId}`);
  console.log(`Token length: ${token?.length || 0}`);
  console.log(`Token starts with: ${token?.substring(0, 20) || 'null'}`);
  
  const res = await fetch(url, {
    method: "GET",
    headers: { 
      authorization: `Bearer ${token}`,
    },
  });
  
  console.log(`Response status: ${res.status} ${res.statusText}`);
  console.log(`Response headers: ${JSON.stringify([...res.headers.entries()])}`);
  
  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`ERROR: Status ${res.status}`);
    console.error(`Error response: ${errorBody?.substring(0, 500)}`);
    return { error: res.status, message: `HTTP ${res.status}: ${errorBody}` };
  }
  
  const json = await res.json();
  console.log(`Content array length: ${json.content?.length || 0}`);
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
          const errorMessage = error?.message || "Unknown PDF error";
          const errorCode = error?.error || "unknown";
          throw new Error(
            `PDF suggestion request failed (clientId=${clientId}, courseId=${courseId}, fileId=${item.externalId}, label=${label}, status=${errorCode}): ${errorMessage}`,
          );
        }
        return {
          captions: [],
          pdfs: [
            ...figureSuggestions.map(({ figureIndex, suggestion }) => ({
              name,
              filename: item.name,
              type: "alt-text",
              language: lang,
              figureIndex,
              existingTitle: "",
              suggestion,
              status: "suggested",
            })),
            { name, filename: item.name, ...titleResult },
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
    const errorMessage = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    console.error(`HANDLER ERROR CAUGHT`);
    console.error(`Error type: ${typeof err}`);
    console.error(`Error keys: ${Object.keys(err || {}).join(', ')}`);
    console.error(`Error message: ${errorMessage}`);
    const errorBody = JSON.stringify({ error: errorMessage });
    console.error(`Returning body: ${errorBody}`);
    return {
      statusCode: 502,
      body: errorBody,
    };
  }
  const response = {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(results),
  };
  return response;
};
