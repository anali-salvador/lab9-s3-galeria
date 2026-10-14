// Galería de imágenes con Amazon S3 y presigned URLs.
// Las credenciales NO están en el código: el SDK usa el perfil de la AWS CLI
// indicado en AWS_PROFILE (cadena de credenciales por defecto del SDK v3).
require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_BUCKET;
const PORT = Number(process.env.PORT) || 3000;

const PREFIX = 'originales/';
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const UPLOAD_URL_TTL = 300; // segundos
const VIEW_URL_TTL = 900; // segundos

if (!BUCKET) {
  console.error('Falta S3_BUCKET en el archivo .env');
  process.exit(1);
}

const s3 = new S3Client({ region: REGION });
const app = express();

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

// Deja solo letras, números, punto, guion y guion bajo; evita "../" y nombres vacíos.
function sanitizeFilename(name) {
  const base = String(name).split(/[\\/]/).pop();
  let clean = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '');
  if (clean.length > 100) clean = clean.slice(-100);
  return clean || 'imagen';
}

// Convierte un error del SDK en un código HTTP y un mensaje en español.
function sendS3Error(res, err, action) {
  const status = err.$metadata?.httpStatusCode;
  console.error(`[${action}]`, err.name, err.message);
  if (err.name === 'AccessDenied' || status === 403) {
    return res.status(403).json({ error: `Permiso denegado en S3 al ${action}.` });
  }
  if (err.name === 'NoSuchBucket') {
    return res.status(404).json({ error: 'El bucket configurado no existe.' });
  }
  if (err.name === 'CredentialsProviderError') {
    return res.status(500).json({ error: 'No se encontraron credenciales de AWS para el perfil configurado.' });
  }
  return res.status(500).json({ error: `Error inesperado al ${action}.` });
}

// 1. Genera una URL firmada para subir una imagen directo a S3.
app.post('/api/upload-url', async (req, res) => {
  try {
    const { filename, contentType } = req.body || {};
    const sizeBytes = Number(req.body?.sizeBytes);

    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'Falta el nombre del archivo (filename).' });
    }
    if (!ALLOWED_TYPES.includes(contentType)) {
      return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo JPG, PNG o WebP.' });
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return res.status(400).json({ error: 'sizeBytes debe ser un número entero mayor que 0.' });
    }
    if (sizeBytes > MAX_BYTES) {
      return res.status(400).json({ error: 'La imagen supera el máximo de 5 MB.' });
    }

    const key = `${PREFIX}${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeFilename(filename)}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
      ServerSideEncryption: 'AES256',
    });

    // Content-Type, Content-Length y el cifrado quedan firmados como cabeceras:
    // si el navegador envía otro tipo, otro tamaño o no envía el cifrado, S3 rechaza la subida.
    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: UPLOAD_URL_TTL,
      signableHeaders: new Set(['content-type', 'content-length']),
      unhoistableHeaders: new Set(['x-amz-server-side-encryption']),
    });

    res.json({
      uploadUrl,
      key,
      headers: { 'Content-Type': contentType, 'x-amz-server-side-encryption': 'AES256' },
    });
  } catch (err) {
    sendS3Error(res, err, 'generar la URL de subida');
  }
});

// 2. Lista las imágenes de originales/ con una URL firmada para verlas.
app.get('/api/images', async (req, res) => {
  try {
    const objects = [];
    let ContinuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken }));
      objects.push(...(page.Contents || []));
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);

    const images = await Promise.all(
      objects
        .filter((obj) => obj.Key !== PREFIX && IMAGE_EXT.test(obj.Key))
        .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
        .map(async (obj) => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
          url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }), {
            expiresIn: VIEW_URL_TTL,
          }),
        }))
    );

    res.json({ count: images.length, images });
  } catch (err) {
    sendS3Error(res, err, 'listar las imágenes');
  }
});

// 3. Elimina una imagen. El frontend envía la key con encodeURIComponent, así que
// "originales/x.jpg" llega como un solo segmento ("originales%2Fx.jpg").
// Express 5 ya decodifica req.params, por lo que aquí llega la key original.
app.delete('/api/images/:key', async (req, res) => {
  try {
    const key = req.params.key;

    if (!key || !key.startsWith(PREFIX) || key.includes('..') || key === PREFIX) {
      return res.status(400).json({ error: 'Key no válida: debe estar dentro de originales/.' });
    }

    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: 'La imagen no existe.' });
      }
      throw err;
    }

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    res.json({ ok: true, key });
  } catch (err) {
    sendS3Error(res, err, 'eliminar la imagen');
  }
});

// Rutas de API desconocidas responden JSON, no HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

// JSON mal formado u otros errores de Express.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// En Express 5 los errores de arranque (p. ej. puerto ocupado) llegan al callback.
app.listen(PORT, (err) => {
  if (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `El puerto ${PORT} ya está en uso por otro programa. Cierra ese programa o cambia PORT en .env.`
        : `No se pudo iniciar el servidor: ${err.message}`
    );
    process.exit(1);
  }
  console.log(`Galería lista en http://localhost:${PORT}`);
  console.log(`Bucket: ${BUCKET} | Región: ${REGION} | Perfil: ${process.env.AWS_PROFILE || 'default'}`);
});
