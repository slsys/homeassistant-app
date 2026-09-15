FROM node:24.13.0-alpine
ARG BUILD_VERSION=0.1.8
ARG BUILD_ARCH
LABEL io.hass.name="SLS" \
      io.hass.description="LocalLink discovery and SLS management" \
      io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}"
ENV NODE_ENV=production SLS_DATA_DIR=/data SLS_PORT=8099
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
COPY frontend ./frontend
CMD ["node", "src/main.mjs"]
