# File: Dockerfile
# syntax=docker/dockerfile:1.4

FROM python:3.11-alpine

# Set default environment variables for user/group IDs
ENV PUID=1000
ENV PGID=1000

# Install necessary system packages FIRST to maximize pip cache hits
# ONLY install what's strictly necessary before pip.
# This step is critical for Alpine images if Python packages need compilation.
RUN apk add --no-cache curl tzdata su-exec dos2unix \
    # Add build tools for Python packages (if needed).
    # You'll need these if your Python packages are compiled from source.
    # Check your pip install logs for "Building wheel for X" or "Failed building wheel for X".
    build-base \
    python3-dev

# Set up the working directory for our code.
WORKDIR /app

# --- CACHE LAYER OPTIMIZATION STARTS HERE ---
# 1. Copy *only* requirements.txt
COPY requirements.txt .

# 2. Install Python dependencies with BuildKit cache mount for pip cache
# This layer will be cached unless requirements.txt changes or a layer above it changes.
# Using cache mount significantly speeds up pip install on subsequent builds
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt
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
  CMD sh -c "curl -fs http://localhost:${FLASK_PORT:-5000}/health || exit 1"
EXPOSE 5000
ENTRYPOINT ["/bin/sh", "/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:${FLASK_PORT:-5000} --forwarded-allow-ips='*' run:app"]
