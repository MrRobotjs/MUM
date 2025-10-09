# File: Dockerfile

FROM python:3.11-alpine

# Set default environment variables for user/group IDs
ENV PUID=1000
ENV PGID=1000

# Install necessary system packages FIRST to maximize pip cache hits
# ONLY install what's strictly necessary before pip.
# This step is critical for Alpine images if Python packages need compilation.
RUN apk add --no-cache curl tzdata su-exec \
    # Add build tools for Python packages (if needed).
    # You'll need these if your Python packages are compiled from source.
    # Check your pip install logs for "Building wheel for X" or "Failed building wheel for X".
    # Common build deps:
    build-base \
    python3-dev \
    # Other potential deps for common libraries:
    # libffi-dev \ # for cryptography
    # openssl-dev # for cryptography
    # jpeg-dev zlib-dev # for Pillow/image processing libs
    # postgresql-dev # for psycopg2
    # mariadb-dev # for mysqlclient
    && rm -rf /var/lib/apt/lists/*

# Set up the working directory for our code.
WORKDIR /app

# --- CACHE LAYER OPTIMIZATION STARTS HERE ---
# 1. Copy *only* requirements.txt
COPY requirements.txt .

# 2. Install Python dependencies
# This layer will be cached unless requirements.txt changes or a layer above it changes.
# Remove --no-cache-dir for faster local builds, keep for production to save image size.
RUN pip install --no-cache-dir -r requirements.txt
# --- CACHE LAYER OPTIMIZATION ENDS HERE ---

# Copy entrypoint script first and make it executable
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && \
    dos2unix /usr/local/bin/entrypoint.sh || true

# Copy the rest of the application code
# This step invalidates cache AFTER pip install, which is good.
COPY . .

# Create necessary directories (user creation moved to entrypoint.sh)
RUN mkdir -p /app/instance /.cache

# Healthcheck and expose (already good)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fs http://localhost:5000/health || exit 1
EXPOSE 5000
ENTRYPOINT ["/bin/sh", "/usr/local/bin/entrypoint.sh"]
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--forwarded-allow-ips", "*", \
     "run:app"]