FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY . .
ENV NODE_ENV=production
ENV PORT=8787
ENV EASYWAY_DB=sqlite
ENV EASYWAY_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
CMD ["node","server.js"]
