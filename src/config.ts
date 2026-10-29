import fs from 'fs';
import path from 'path';

interface Config {
  forwardToNumber: string;
  timeoutMinutes: number;
  broadcastLabel: string;
}

export function loadConfig(): Config {
  const envPath = path.join(process.cwd(), '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  
  const config: any = {};
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      config[key.trim()] = value.trim();
    }
  });

  return {
    forwardToNumber: config.FORWARD_TO_NUMBER || '',
    timeoutMinutes: parseInt(config.TIMEOUT_MINUTES) || 5,
    broadcastLabel: config.BROADCAST_LABEL || 'Subscribers'
  };
}
