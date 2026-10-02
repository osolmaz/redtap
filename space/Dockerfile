FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ src/
ENV PORT=7860
CMD ["node", "--experimental-strip-types", "src/server.ts"]
