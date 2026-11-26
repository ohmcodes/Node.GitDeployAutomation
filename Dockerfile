FROM node:lts-alpine
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose
WORKDIR /usr/src/app

ENV NODE_ENV=production \
    PORT=3014 \
    HOST=0.0.0.0 \
    DATA_DIR=/srv/git-deploy

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /srv/git-deploy

EXPOSE 3014
CMD ["node", "server.js"]
    