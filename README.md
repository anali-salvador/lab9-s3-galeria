# Galería de imágenes con S3

App web que hice para el laboratorio 9 de S3. Sirve para subir imágenes a un bucket de Amazon S3, verlas en una galería y eliminarlas.

Las imágenes no pasan por el servidor: el backend (Node.js + Express) genera **presigned URLs** y el navegador sube y descarga los archivos directo desde S3. El frontend no tiene ninguna credencial de AWS.

- Solo acepta JPG, PNG y WebP de máximo 5 MB.
- Las imágenes se guardan en la carpeta `originales/` del bucket.
- Las URLs para subir duran 5 minutos y las de ver, 15 minutos.

## Requisitos

- Node.js 18 o superior
- AWS CLI con un perfil configurado (`aws configure --profile nombre-del-perfil`)
- Un bucket de S3 con CORS que permita `PUT` y `GET` desde `http://localhost:3000`

## Instalación

```bash
npm install
```

## Configuración

Copia el archivo de ejemplo y cambia los valores por los tuyos:

```bash
cp .env.example .env
```

```
AWS_REGION=us-east-1
S3_BUCKET=nombre-de-tu-bucket
PORT=3000
AWS_PROFILE=nombre-de-tu-perfil
```

El SDK toma las credenciales del perfil de la AWS CLI que pongas en `AWS_PROFILE`, así que en el `.env` no van claves.

## Uso

```bash
npm start
```

Luego abre http://localhost:3000 en el navegador.

## Nota sobre las credenciales

Las Access Keys **nunca** van en el repositorio. El `.env` está en el `.gitignore` y las claves solo están en el perfil de la AWS CLI de mi computadora.
