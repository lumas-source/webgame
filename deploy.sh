#!/bin/bash
# deploy.sh

echo "Starting deployment..."

# Pull latest code
git pull origin main

# Install dependencies
npm install

# Build client assets (if needed)
# npm run build

# Restart application with PM2
pm2 restart ecosystem.config.js --env production

echo "Deployment complete!"