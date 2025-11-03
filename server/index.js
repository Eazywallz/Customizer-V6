import express from 'express';
import multer from 'multer';

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || "";

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// --- CORS: allow Shopify frontends to call this API ---
const allowList = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (!allowList.length || allowList.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || allowList[0] || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end(); // handle preflight
  next();
});


async function shopifyGraphQL(query, variables) {
  const resp = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json));
  }
  return json.data;
}

app.post('/apps/eazy-cropper/crop', upload.single('file'), async (req, res) => {
  try {
    const bytes = req.file?.buffer;
    if (!bytes) return res.status(400).json({ error: 'No file provided' });

    const stageQuery = `
      mutation stagedUploadsCreate($inputs: [StagedUploadInput!]!) {
        stagedUploadsCreate(inputs: $inputs) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `;
    const stageVars = {
      inputs: [{
        filename: `ewz-preview-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
        httpMethod: "POST",
        resource: "FILE"
      }]
    };
    const stage = await shopifyGraphQL(stageQuery, stageVars);
    const target = stage.stagedUploadsCreate.stagedTargets[0];

    const formData = new FormData();
    target.parameters.forEach(p => formData.append(p.name, p.value));
    formData.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'preview.jpg');

    const upResp = await fetch(target.url, { method: 'POST', body: formData });
    if (!upResp.ok) throw new Error('Upload failed');

    const fileQuery = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            __typename
            ... on GenericFile { url }
            ... on MediaImage { image { url } }
          }
          userErrors { field message }
        }
      }
    `;
    const fileVars = {
      files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", filename: `ewz-preview-${Date.now()}.jpg` }]
    };
    const fileData = await shopifyGraphQL(fileQuery, fileVars);
    const created = fileData.fileCreate.files[0];
    const url = created?.image?.url || created?.url;
    if (!url) throw new Error('No URL returned');

    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

export default app;
