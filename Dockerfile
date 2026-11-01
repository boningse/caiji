FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Build backend (if needed, otherwise tsx will run it)
# We will just run it with tsx in production for simplicity, or compile it.
# The project currently uses `tsx` to run the server.

FROM node:20-alpine

WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm install tsx typescript -g

# Copy backend source code and config
COPY api/ ./api/
COPY tsconfig*.json ./
COPY vite.config.ts ./

# Copy built frontend
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Expose port
EXPOSE 3000

# Set environment variables
ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV PORT=3000
# 增加 Node.js 老生代内存上限至 4GB，以应对大量并发数据解析与缓存
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Start the server
CMD ["tsx", "api/server.ts"]