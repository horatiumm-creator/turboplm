FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV UPLOAD_DIR=/app/uploads
EXPOSE 4100
CMD ["node", "src/index.js"]
