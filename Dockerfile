FROM node:22-alpine
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3014 DATA_DIR=/srv/git-deploy
EXPOSE 3014
CMD ["node", "server.js"]
    