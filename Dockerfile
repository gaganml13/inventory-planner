# Multi-runtime production container: Node.js 22 (native node:sqlite) + Python 3.11 on Debian Bookworm
FROM node:22-bookworm

# Install Python 3.11, pip, python-is-python3 symlink, and C/OpenMP dependencies (libgomp1 required for LightGBM)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python-is-python3 \
    build-essential \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Ensure persistent data directory exists with full write permissions for SQLite database and WAL files
RUN mkdir -p /data && chmod 777 /data

# Set application directory
WORKDIR /app

# Copy Node dependency definitions first for optimal layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy Python requirements from ml/ and install using pip
COPY ml/requirements.txt ./ml/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r ml/requirements.txt

# Copy all application source code
COPY . .

# Set default production environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Expose HTTP port
EXPOSE 3000

# Start unified Node.js + Python application
CMD ["npm", "start"]
