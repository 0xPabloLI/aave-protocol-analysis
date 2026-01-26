#!/bin/bash
set -e

# Usage: ./deploy.sh [host]
# host can be: ipv6server or 43.247.134.242

if [ -z "$1" ]; then
  echo "Error: No target host specified"
  echo "Usage: ./deploy.sh [host]"
  echo "Available hosts:"
  echo "  - ipv6server"
  echo "  - 43.247.134.242"
  exit 1
fi

TARGET_HOST=$1
echo "Starting manual deployment to production server: $TARGET_HOST..."

# Read DOPPLER_TOKEN from local .env file (if exists)
# This allows you to store DOPPLER_TOKEN in local .env and have it automatically passed to the server
DOPPLER_TOKEN_FROM_ENV=""
if [ -f ".env" ]; then
  echo "📋 Reading DOPPLER_TOKEN from local .env file..."
  # Parse .env file to extract DOPPLER_TOKEN
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Check if this line contains DOPPLER_TOKEN
    if [[ "$line" =~ ^[[:space:]]*DOPPLER_TOKEN[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      DOPPLER_TOKEN_FROM_ENV="${BASH_REMATCH[1]}"
      # Remove surrounding quotes if present
      DOPPLER_TOKEN_FROM_ENV=$(echo "$DOPPLER_TOKEN_FROM_ENV" | sed 's/^["'\'']//;s/["'\'']$//')
      echo "✅ Found DOPPLER_TOKEN in local .env (will be passed to remote server)"
      break
    fi
  done < ".env"
fi

# If DOPPLER_TOKEN is found in .env, export it so it can be passed to remote via SSH
if [ -n "$DOPPLER_TOKEN_FROM_ENV" ]; then
  export DOPPLER_TOKEN="$DOPPLER_TOKEN_FROM_ENV"
  echo "💡 DOPPLER_TOKEN will be injected into remote PM2 environment via SSH"
else
  echo "ℹ️  No DOPPLER_TOKEN found in local .env (will use remote server's existing DOPPLER_TOKEN if set)"
fi
echo ""

# Connect to the server with explicit SSH agent forwarding and run commands
# Security Note: Base64 encoding is NOT encryption - it's easily reversible.
# The real security comes from:
# 1. SSH connection encryption (protects data in transit)
# 2. Base64 encoding only prevents token from appearing in plain text in:
#    - Script files (heredoc content)
#    - Command history (if script is saved)
#    - Simple log scanning
# However, anyone with access to the SSH session or process list can still decode it.
# For production, consider using SSH environment variable passing or a more secure method.
DOPPLER_TOKEN_B64=""
if [ -n "$DOPPLER_TOKEN" ]; then
  # Encode token to base64 (NOT encryption, just encoding to avoid plain text in script)
  DOPPLER_TOKEN_B64=$(echo -n "$DOPPLER_TOKEN" | base64)
fi

# Use 'EOF' (quoted) to prevent variable expansion in the heredoc
# DOPPLER_TOKEN_B64 will be passed as a command-line argument, not embedded in the script
ssh -A -t "$TARGET_HOST" bash -s "$DOPPLER_TOKEN_B64" << 'REMOTE_SCRIPT'
  # Decode DOPPLER_TOKEN from base64 if provided
  # The encoded token is passed as the first command-line argument ($1)
  # Note: Base64 is easily reversible - this is NOT encryption, just encoding
  if [ -n "$1" ] && [ "$1" != "" ]; then
    # base64 -d works on Linux (most common on servers)
    # base64 -D works on macOS, but we're deploying to Linux servers
    if command -v base64 > /dev/null 2>&1; then
      export DOPPLER_TOKEN=$(echo -n "$1" | base64 -d 2>/dev/null || echo -n "$1" | base64 -D 2>/dev/null)
      if [ -n "$DOPPLER_TOKEN" ]; then
        echo "✅ DOPPLER_TOKEN decoded and exported in remote shell environment (will be available to PM2)"
      else
        echo "⚠️  Failed to decode DOPPLER_TOKEN, continuing without it"
      fi
    else
      echo "⚠️  base64 command not found, cannot decode DOPPLER_TOKEN"
    fi
  fi
  
  echo "Connected to remote server..."
  
  # --- Node.js/NVM logic: always ensure node is available at the start ---
  REQUIRED_NODE_VERSION="20.18.1"
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    if ! nvm ls "$REQUIRED_NODE_VERSION" > /dev/null 2>&1; then
      echo "Node.js v$REQUIRED_NODE_VERSION not found in nvm. Installing..."
      nvm install "$REQUIRED_NODE_VERSION"
    fi
    nvm use "$REQUIRED_NODE_VERSION"
  else
    echo "NVM not found. Installing NVM..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      . "$NVM_DIR/nvm.sh"
      nvm install "$REQUIRED_NODE_VERSION"
      nvm use "$REQUIRED_NODE_VERSION"
    else
      echo "Failed to install NVM. Please install it manually."
      exit 1
    fi
  fi
  CURRENT_NODE_VERSION=$(node -v | cut -d 'v' -f 2)
  echo "Now using Node.js v$CURRENT_NODE_VERSION (required: v$REQUIRED_NODE_VERSION)"
  # --- End Node.js/NVM logic ---
  
  # Install essential system tools (git, curl, build tools)
  echo "Installing essential system tools..."
  if command -v apt-get &> /dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y \
      git \
      curl \
      build-essential \
      ca-certificates || {
      echo "⚠️  Some essential tools failed to install, but continuing..."
    }
    echo "✅ Essential tools installed"
  elif command -v yum &> /dev/null; then
    sudo yum install -y \
      git \
      curl \
      gcc \
      gcc-c++ \
      make \
      ca-certificates || {
      echo "⚠️  Some essential tools failed to install, but continuing..."
    }
    echo "✅ Essential tools installed"
  fi
  
  # Install system dependencies for Puppeteer (Chrome/Chromium)
  echo "Installing system dependencies for Puppeteer..."
  if command -v apt-get &> /dev/null; then
    # Ubuntu/Debian
    sudo apt-get install -y \
      fonts-liberation \
      libappindicator3-1 \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libgcc1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libstdc++6 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      lsb-release \
      wget \
      xdg-utils || {
      echo "⚠️  Some system dependencies failed to install, but continuing..."
    }
    echo "✅ Puppeteer dependencies installed"
  elif command -v yum &> /dev/null; then
    # CentOS/RHEL
    sudo yum install -y \
      alsa-lib \
      atk \
      cups-libs \
      gtk3 \
      ipa-gothic-fonts \
      libXcomposite \
      libXcursor \
      libXdamage \
      libXext \
      libXi \
      libXrandr \
      libXScrnSaver \
      libXtst \
      pango \
      xorg-x11-fonts-100dpi \
      xorg-x11-fonts-75dpi \
      xorg-x11-utils || {
      echo "⚠️  Some system dependencies failed to install, but continuing..."
    }
    echo "✅ System dependencies installed"
  else
    echo "⚠️  Unsupported package manager. Please install Puppeteer dependencies manually."
  fi
  
  # Check if pm2 is installed, if not install it
  if ! command -v pm2 &> /dev/null; then
    echo "PM2 not found. Installing PM2..."
    npm install -g pm2
    
    # Check if installation was successful
    if ! command -v pm2 &> /dev/null; then
      echo "Failed to install PM2 globally. Trying with sudo..."
      sudo npm install -g pm2
      
      if ! command -v pm2 &> /dev/null; then
        echo "Error: Failed to install PM2. Please install it manually."
        exit 1
      fi
    fi
    
    echo "PM2 installed successfully!"
  else
    echo "PM2 is already installed."
  fi
  
  # Show pm2 status
  echo "--- PM2 Status ---"
  pm2 status
  echo "------------------"
  
  # Check and install Doppler CLI (for Secret Manager integration)
  echo "Checking Doppler CLI installation..."
  if ! command -v doppler &> /dev/null; then
    echo "Doppler CLI not found. Installing..."
    # Install Doppler CLI (official installation script)
    curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh || {
      echo "⚠️  Failed to install Doppler CLI. Continuing deployment, but secrets may not be available."
      echo "💡 To install manually: curl -Ls https://cli.doppler.com/install.sh | sh"
    }
    
    # Verify installation
    if command -v doppler &> /dev/null; then
      echo "✅ Doppler CLI installed successfully"
    else
      echo "⚠️  Doppler CLI installation failed. Please install manually."
    fi
  else
    echo "✅ Doppler CLI is already installed"
    doppler --version || echo "⚠️  Doppler CLI found but version check failed"
  fi
  
  # Check if DOPPLER_TOKEN is set in the environment
  # It may come from:
  # 1. Local .env file (passed via SSH from deploy.sh)
  # 2. Remote server's existing environment (e.g., ~/.bashrc, /etc/environment)
  # IMPORTANT: Never echo the actual token value to avoid logging it
  echo "Checking DOPPLER_TOKEN environment variable..."
  if [ -z "$DOPPLER_TOKEN" ]; then
    echo "⚠️  WARNING: DOPPLER_TOKEN is not set in the current environment."
    echo "💡 The application will fall back to reading .env file (if exists) or use defaults."
    echo "💡 Options to set DOPPLER_TOKEN:"
    echo "   1. Add DOPPLER_TOKEN to local .env file (will be auto-passed via deploy.sh)"
    echo "   2. Add it to remote server's ~/.bashrc: export DOPPLER_TOKEN='your-token-here'"
    echo "   3. Add it to remote server's /etc/environment: DOPPLER_TOKEN='your-token-here'"
    echo ""
    echo "⚠️  Continuing deployment, but secrets from Secret Manager will not be available."
  else
    # Token is set, but we don't log anything about it to avoid any potential leaks
    # The token will be injected into PM2 process environment via --update-env
    echo "✅ DOPPLER_TOKEN is set (will be injected into PM2 process environment)"
  fi
  echo ""
  
  # Fix 1: Ensure GitHub is in known_hosts for SSH fetch
  if ! ssh-keygen -F github.com > /dev/null; then
    echo "Adding github.com to known_hosts..."
    ssh-keyscan github.com >> ~/.ssh/known_hosts
  fi
  
  # Configure npm to use faster registry if needed (optional)
  # Uncomment if server is in China and want to use Taobao mirror:
  # npm config set registry https://registry.npmmirror.com

  # Navigate to the project directory
  cd /root
  
  # Check if source directory exists, create if not
  if [ ! -d "aave" ]; then
    echo "Creating aave directory..."
    mkdir -p aave
    cd aave
    git init
    git remote add origin git@github.com:0xPabloLI/aave-protocol-analysis.git
  else
    cd aave
  fi
    
  # Fetch and pull latest changes
  echo "Fetching latest changes from GitHub..."
  # Save current package-lock.json hash before git reset (to check if dependencies changed)
  OLD_ROOT_HASH=""
  ROOT_HASH_FILE=".package-lock-hash"
  if [ -f "package-lock.json" ] && [ -f "$ROOT_HASH_FILE" ]; then
    OLD_ROOT_HASH=$(cat "$ROOT_HASH_FILE" 2>/dev/null || echo "")
  fi
  
  # Try to fetch from main branch first, fallback to master
  if git ls-remote --heads origin main | grep -q main; then
    git fetch origin main
    git reset --hard origin/main
  else
    git fetch origin master
    git reset --hard origin/master
  fi

  # Ensure package-lock.json exists for root directory
  if [ ! -f package-lock.json ]; then
    echo "package-lock.json not found in root directory! Please commit and push it from your local machine. Aborting deployment."
    exit 1
  fi

  # Ensure ecosystem.config.cjs exists
  if [ ! -f ecosystem.config.cjs ]; then
    echo "ecosystem.config.cjs not found in the repository! Please add it and push. Aborting deployment."
    exit 1
  fi

  # Install root directory dependencies (for data fetching script)
  # Check if dependencies need to be reinstalled by comparing package-lock.json hash
  NEW_ROOT_HASH=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || md5 -q package-lock.json 2>/dev/null || sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "")
  ROOT_NODE_MODULES_HASH=""
  if [ -f "node_modules/.package-lock.json" ]; then
    ROOT_NODE_MODULES_HASH=$(md5sum node_modules/.package-lock.json 2>/dev/null | cut -d' ' -f1 || md5 -q node_modules/.package-lock.json 2>/dev/null || sha256sum node_modules/.package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "")
  fi
  
  if [ -n "$NEW_ROOT_HASH" ] && [ -n "$OLD_ROOT_HASH" ] && [ "$NEW_ROOT_HASH" = "$OLD_ROOT_HASH" ] && [ -d "node_modules" ]; then
    echo "✅ Dependencies are up to date (package-lock.json unchanged), skipping installation..."
    # Update hash file timestamp
    echo "$NEW_ROOT_HASH" > "$ROOT_HASH_FILE"
  elif [ -n "$NEW_ROOT_HASH" ] && [ -n "$ROOT_NODE_MODULES_HASH" ] && [ "$NEW_ROOT_HASH" = "$ROOT_NODE_MODULES_HASH" ] && [ -d "node_modules" ]; then
    echo "✅ Dependencies already match the new package-lock.json, skipping installation..."
    echo "$NEW_ROOT_HASH" > "$ROOT_HASH_FILE"
  else
    echo "Installing root directory dependencies..."
    # npm ci automatically removes node_modules and reinstalls based on package-lock.json
    # This ensures unused packages (like puppeteer) are removed
    # Use --prefer-offline to use cache when possible, --no-audit to skip security audit, --loglevel=error to reduce output
    npm ci --prefer-offline --no-audit --loglevel=error || npm ci --no-audit --loglevel=error
    if [ -n "$NEW_ROOT_HASH" ]; then
      echo "$NEW_ROOT_HASH" > "$ROOT_HASH_FILE"
    fi
    echo "✅ Dependencies installed successfully (old unused packages removed)"
  fi
  
  # Build root directory code (data fetching script)
  echo "Building root directory code..."
  npm run build
  
  # Run initial data fetch (generate initial data)
  echo "Running initial data fetch..."
  mkdir -p data
  node dist/index.js || echo "⚠️  Initial data fetch failed, but continuing deployment..."
  
  # Ensure data file is in the correct location (data service expects it in /root/aave/data/)
  if [ -f "backend/data/aave-formatted-data.json" ] && [ ! -f "data/aave-formatted-data.json" ]; then
    echo "Copying data file to correct location..."
    cp backend/data/aave-formatted-data.json data/
  fi
  
  # Install backend dependencies
  cd backend
  if [ ! -f package-lock.json ]; then
    echo "package-lock.json not found in backend directory! Please commit and push it. Aborting deployment."
    exit 1
  fi
  
  # Save current package-lock.json hash before checking (from previous deployment)
  OLD_BACKEND_HASH=""
  BACKEND_HASH_FILE=".package-lock-hash"
  if [ -f "$BACKEND_HASH_FILE" ]; then
    OLD_BACKEND_HASH=$(cat "$BACKEND_HASH_FILE" 2>/dev/null || echo "")
  fi
  
  # Check if dependencies need to be reinstalled by comparing package-lock.json hash
  NEW_BACKEND_HASH=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || md5 -q package-lock.json 2>/dev/null || sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "")
  BACKEND_NODE_MODULES_HASH=""
  if [ -f "node_modules/.package-lock.json" ]; then
    BACKEND_NODE_MODULES_HASH=$(md5sum node_modules/.package-lock.json 2>/dev/null | cut -d' ' -f1 || md5 -q node_modules/.package-lock.json 2>/dev/null || sha256sum node_modules/.package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "")
  fi
  
  if [ -n "$NEW_BACKEND_HASH" ] && [ -n "$OLD_BACKEND_HASH" ] && [ "$NEW_BACKEND_HASH" = "$OLD_BACKEND_HASH" ] && [ -d "node_modules" ]; then
    echo "✅ Backend dependencies are up to date (package-lock.json unchanged), skipping installation..."
    # Update hash file timestamp
    echo "$NEW_BACKEND_HASH" > "$BACKEND_HASH_FILE"
  elif [ -n "$NEW_BACKEND_HASH" ] && [ -n "$BACKEND_NODE_MODULES_HASH" ] && [ "$NEW_BACKEND_HASH" = "$BACKEND_NODE_MODULES_HASH" ] && [ -d "node_modules" ]; then
    echo "✅ Backend dependencies already match the new package-lock.json, skipping installation..."
    echo "$NEW_BACKEND_HASH" > "$BACKEND_HASH_FILE"
  else
    echo "Installing backend dependencies..."
    # npm ci automatically removes node_modules and reinstalls based on package-lock.json
    # Use --prefer-offline to use cache when possible, --no-audit to skip security audit, --loglevel=error to reduce output
    npm ci --prefer-offline --no-audit --loglevel=error || npm ci --no-audit --loglevel=error
    if [ -n "$NEW_BACKEND_HASH" ]; then
      echo "$NEW_BACKEND_HASH" > "$BACKEND_HASH_FILE"
    fi
    echo "✅ Backend dependencies installed successfully (old unused packages removed)"
  fi
  
  # Build backend code
  echo "Building backend code..."
  npm run build
  
  # Ensure required directories exist
  echo "Ensuring required directories exist..."
  mkdir -p logs
  cd ..
  
  # Note: we intentionally do NOT rely on a server-side .env file.
  # Secrets should be provided via Secret Manager (e.g. Doppler) using DOPPLER_TOKEN in the server environment.
  
  # DOPPLER_TOKEN is already exported in the remote shell environment (decoded from base64)
  # This ensures PM2 can access it when evaluating ecosystem.config.cjs and starting processes
  # Security: Token was passed as base64-encoded command argument, not in plain text
  
  # Check if the backend app is running
  if pm2 list | grep -q "aave-backend" && pm2 show aave-backend | grep -q "online"; then
    echo "Aave backend is running. Reloading with PM2..."
    # Reload from root directory where ecosystem.config.cjs is located
    # DOPPLER_TOKEN is now in the environment, so PM2 will pass it to the process
    pm2 reload ecosystem.config.cjs --only aave-backend --update-env
    echo "--- PM2 Status after reload aave-backend ---"
    pm2 status
    echo "----------------------------------------------"
  else
    echo "Aave backend is not running. Starting with PM2..."
    # Start from root directory where ecosystem.config.cjs is located
    # DOPPLER_TOKEN is now in the environment, so PM2 will pass it to the process
    pm2 start ecosystem.config.cjs --only aave-backend --env production --update-env
    echo "--- PM2 Status after start aave-backend ---"
    pm2 status
    echo "---------------------------------------------"
  fi
  
  # Configure PM2 log rotation
  echo "Configuring PM2 log rotation..."
  
  # Install PM2 logrotate module if not installed
  if ! pm2 list | grep -q "pm2-logrotate"; then
    echo "Installing PM2 logrotate module..."
    pm2 install pm2-logrotate
    echo "--- PM2 Status after install pm2-logrotate ---"
    pm2 status
    echo "------------------------------------------------"
  fi
  
  # Configure logrotate settings
  echo "Setting PM2 logrotate configuration..."
  # PM2 logrotate manages stdout/stderr logs from PM2 processes
  # - max_size: 50M - rotate when log file reaches 50MB
  # - retain: 7 - keep 7 rotated log files (total ~350MB)
  # - compress: false - don't compress (faster, but uses more disk space)
  # - rotateInterval: "" - rotate based on size only (not time-based)
  pm2 set pm2-logrotate:max_size 50M pm2-logrotate:retain 7 pm2-logrotate:compress false pm2-logrotate:rotateInterval ""
  echo "--- PM2 Status after set logrotate config ---"
  pm2 status
  echo "---------------------------------------------"
  echo ""
  echo "📋 Log Management Summary:"
  echo "  • PM2 logs (stdout/stderr): ~/.pm2/logs/ - auto-rotated by pm2-logrotate (50MB max, 7 files retained)"
  echo "  • Winston logs (application): backend/logs/ - auto-rotated by Winston (5MB max, 5 files retained per log type)"
  echo "  • Total log retention: ~400MB (PM2) + ~50MB (Winston) = ~450MB maximum"
  echo ""
  
  # Save PM2 process list
  echo "Saving PM2 process list..."
  pm2 save
  
  # Check if firewall allows port 80 (for Cloudflare HTTPS)
  echo "Checking firewall configuration for port 80..."
  if command -v ufw &> /dev/null; then
    if ! ufw status | grep -q "80"; then
      echo "Opening port 80 in UFW firewall..."
      sudo ufw allow 80/tcp
      echo "Port 80 is now open in UFW"
    else
      echo "Port 80 is already allowed in UFW"
    fi
  elif command -v firewall-cmd &> /dev/null; then
    if ! sudo firewall-cmd --list-ports | grep -q "80"; then
      echo "Opening port 80 in firewalld..."
      sudo firewall-cmd --permanent --add-port=80/tcp
      sudo firewall-cmd --reload
      echo "Port 80 is now open in firewalld"
    else
      echo "Port 80 is already allowed in firewalld"
    fi
  else
    echo "⚠️  No firewall management tool found (ufw/firewalld). Please manually ensure port 80 is open."
  fi
  
  # Also ensure port 443 is open (for direct HTTPS if needed)
  echo "Checking firewall configuration for port 443..."
  if command -v ufw &> /dev/null; then
    if ! ufw status | grep -q "443"; then
      echo "Opening port 443 in UFW firewall..."
      sudo ufw allow 443/tcp
      echo "Port 443 is now open in UFW"
    fi
  elif command -v firewall-cmd &> /dev/null; then
    if ! sudo firewall-cmd --list-ports | grep -q "443"; then
      echo "Opening port 443 in firewalld..."
      sudo firewall-cmd --permanent --add-port=443/tcp
      sudo firewall-cmd --reload
      echo "Port 443 is now open in firewalld"
    fi
  fi
  
  # Display service information
  echo ""
  echo "=========================================="
  echo "Deployment completed successfully!"
  echo "=========================================="
  echo "Service URL: http://43.247.134.242"
  echo "Health check: http://43.247.134.242/health"
  echo "API endpoint: http://43.247.134.242/api/markets"
  echo ""
  echo "If using Cloudflare with HTTPS:"
  echo "HTTPS URL: https://api.aaveapy.com"
  echo "Health check: https://api.aaveapy.com/health"
  echo "API endpoint: https://api.aaveapy.com/api/markets"
  echo ""
  echo "PM2 Status:"
  pm2 status
  echo ""
REMOTE_SCRIPT

echo "Deployment script execution finished."
