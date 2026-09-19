FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY food-proxy.js ./

ENV NODE_ENV=production
ENV PORT=80
ENV FOOD_PROXY_PORT=80
ENV FOOD_PROXY_HOST=0.0.0.0
ENV FOOD_PROXY_AUTH_MODE=cloudbase

EXPOSE 80
CMD ["node", "food-proxy.js"]
