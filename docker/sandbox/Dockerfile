# NeoAcademy verification sandbox.
#
# Book code is compiled, built, tested and run ONLY inside containers made
# from this image: no network (except the separate dependency-download step,
# which runs no project code), read-only root filesystem, no capabilities,
# CPU / memory / process limits, and only a scratch folder mounted.
#
# Build it once (from the NeoAcademy folder):
#   docker build -t neoacademy-sandbox:1 docker/sandbox
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build pkg-config \
      clang \
      python3 python3-pip python3-venv \
      nodejs npm \
      fp-compiler fp-units-base fp-units-fcl \
      default-jdk-headless \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && npm install -g typescript@5 && npm cache clean --force

# Unprivileged user; the scratch folder is mounted at /work.
RUN useradd -m -u 1000 sandbox
USER sandbox
ENV HOME=/tmp/home NPM_CONFIG_CACHE=/tmp/npm-cache PIP_CACHE_DIR=/tmp/pip-cache
WORKDIR /work
