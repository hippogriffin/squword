FROM node:24-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --only=production

# Bundle app source
COPY . .

# Expose default port
EXPOSE 3000

# Create a writable data directory for the DB and make it available as a mount
RUN mkdir -p /data

# Use non-root user for better security, ensure /data is writable by that user
RUN addgroup -S scrabble && adduser -S scrabble -G scrabble && chown -R scrabble:scrabble /data /usr/src/app

# Expose /data as a volume so callers can mount persistent storage
VOLUME ["/data"]

# Let the app know where to write its DB file by default
ENV SCRABBLE_DB=/data/scrabble-db.json

USER scrabble

CMD [ "npm", "start" ]
