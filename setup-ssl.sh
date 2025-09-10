#!/bin/bash
# setup-ssl.sh

echo "Setting up SSL certificates..."

# Install Certbot
sudo apt update
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Test renewal process
sudo certbot renew --dry-run

echo "SSL setup complete!"