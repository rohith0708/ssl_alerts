#!/usr/bin/env bash
# Quick-start deploy for a fresh Ubuntu 22.04/24.04 2GB VPS using Docker.
# Run this FROM the project folder after uploading it to the server.
set -e

echo "== HariSree SSL Alerts — server setup =="

if ! command -v docker &> /dev/null; then
  echo "-- Installing Docker --"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  echo "-- Installing Docker Compose plugin --"
  sudo apt-get update && sudo apt-get install -y docker-compose-plugin
fi

if [ ! -f .env ]; then
  echo "-- Creating .env from template — EDIT THIS before continuing --"
  cp .env.example .env
  echo "Edit .env now (JWT_SECRET, SMTP_*, APP_URL), then re-run this script."
  exit 0
fi

mkdir -p data

echo "-- Building and starting the app --"
docker compose up -d --build

echo ""
echo "== Done =="
echo "App is running on port 3000."
echo "Next steps:"
echo "  1. Point your domain's DNS A record at this server's IP."
echo "  2. Install nginx + certbot, use deploy/nginx.conf as a template."
echo "  3. Run: sudo certbot --nginx -d yourdomain.com"
echo "  4. Visit https://yourdomain.com"
