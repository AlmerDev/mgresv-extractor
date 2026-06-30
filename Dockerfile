FROM mcr.microsoft.com/playwright:v1.49.1-noble

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 8080

CMD ["npm", "start"]
