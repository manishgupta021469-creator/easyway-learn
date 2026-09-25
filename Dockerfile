FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-hin \
    poppler-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
EXPOSE 8787
CMD ["node","server.js"]
