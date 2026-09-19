FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY food-proxy.js ./

ENV NODE_ENV=production
ENV FOOD_PROXY_HOST=0.0.0.0
ENV FOOD_PROXY_AUTH_MODE=cloudbase

USER node
CMD ["node", "food-proxy.js"]
