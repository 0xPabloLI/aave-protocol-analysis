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

# Connect to the server with explicit SSH agent forwarding and run commands
ssh -A -t "$TARGET_HOST" << 'EOF'
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
  
  # Fix 1: Ensure GitHub is in known_hosts for SSH fetch
  if ! ssh-keygen -F github.com > /dev/null; then
    echo "Adding github.com to known_hosts..."
    ssh-keyscan github.com >> ~/.ssh/known_hosts
  fi

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
  echo "Installing root directory dependencies..."
  npm ci
  
  # Build root directory code (data fetching script)
  echo "Building root directory code..."
  npm run build
  
  # Run initial data fetch (generate initial data)
  echo "Running initial data fetch..."
  mkdir -p data
  node dist/index.js || echo "⚠️  Initial data fetch failed, but continuing deployment..."
  
  # Install backend dependencies
  echo "Installing backend dependencies..."
  cd backend
  if [ ! -f package-lock.json ]; then
    echo "package-lock.json not found in backend directory! Please commit and push it. Aborting deployment."
    exit 1
  fi
  npm ci
  
  # Build backend code
  echo "Building backend code..."
  npm run build
  
  # Ensure required directories exist
  echo "Ensuring required directories exist..."
  mkdir -p logs
  cd ..
  
  # Check if the backend app is running
  if pm2 list | grep -q "aave-backend" && pm2 show aave-backend | grep -q "online"; then
    echo "Aave backend is running. Reloading with PM2..."
    # Reload from root directory where ecosystem.config.cjs is located
    pm2 reload ecosystem.config.cjs --only aave-backend
    echo "--- PM2 Status after reload aave-backend ---"
    pm2 status
    echo "----------------------------------------------"
  else
    echo "Aave backend is not running. Starting with PM2..."
    # Start from root directory where ecosystem.config.cjs is located
    pm2 start ecosystem.config.cjs --only aave-backend --env production
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
  pm2 set pm2-logrotate:max_size 50M pm2-logrotate:retain 2 pm2-logrotate:compress false pm2-logrotate:rotateInterval ""
  echo "--- PM2 Status after set logrotate config ---"
  pm2 status
  echo "---------------------------------------------"
  
  # Save PM2 process list
  echo "Saving PM2 process list..."
  pm2 save
  
  # Check if firewall allows port 3001
  echo "Checking firewall configuration for port 3001..."
  if command -v ufw &> /dev/null; then
    if ! ufw status | grep -q "3001"; then
      echo "Opening port 3001 in UFW firewall..."
      sudo ufw allow 3001/tcp
      echo "Port 3001 is now open in UFW"
    else
      echo "Port 3001 is already allowed in UFW"
    fi
  elif command -v firewall-cmd &> /dev/null; then
    if ! sudo firewall-cmd --list-ports | grep -q "3001"; then
      echo "Opening port 3001 in firewalld..."
      sudo firewall-cmd --permanent --add-port=3001/tcp
      sudo firewall-cmd --reload
      echo "Port 3001 is now open in firewalld"
    else
      echo "Port 3001 is already allowed in firewalld"
    fi
  else
    echo "⚠️  No firewall management tool found (ufw/firewalld). Please manually ensure port 3001 is open."
  fi
  
  # Display service information
  echo ""
  echo "=========================================="
  echo "Deployment completed successfully!"
  echo "=========================================="
  echo "Service URL: http://43.247.134.242:3001"
  echo "Health check: http://43.247.134.242:3001/health"
  echo "API endpoint: http://43.247.134.242:3001/api/markets"
  echo ""
  echo "PM2 Status:"
  pm2 status
  echo ""
EOF

echo "Deployment script execution finished."

