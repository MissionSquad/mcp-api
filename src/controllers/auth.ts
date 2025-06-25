import { Express, Request, Response } from 'express';
import { MCPService } from '../services/mcp';
import { Secrets } from '../services/secrets';

export class AuthController {
  constructor(private app: Express, private mcpService: MCPService, private secretsService: Secrets) {}

  public registerRoutes(): void {
    this.app.get('/auth/google/login', this.googleLogin.bind(this));
    this.app.get('/auth/google/callback', this.googleCallback.bind(this));
  }

  private async googleLogin(req: Request, res: Response): Promise<void> {
    const userId = req.query.user_id as string; // Or get from session/JWT
    if (!userId) {
      res.status(400).json({ success: false, error: 'user_id is required' });
      return;
    }

    try {
      const authUrl = await this.mcpService.callTool(
        userId,
        'mcp-google-workspace',
        'auth_get_authorization_url',
        { user_id: userId }
      );
      if (typeof authUrl !== 'string') {
        res.status(500).json({ success: false, error: `Invalid authUrl type: ${typeof authUrl}`}) 
        return
      }
      res.redirect(authUrl);
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  private async googleCallback(req: Request, res: Response): Promise<void> {
    const code = req.query.code as string;
    const state = req.query.state as string;

    try {
      const tokensString = await this.mcpService.callTool(
        'default', // No specific user context needed here yet
        'mcp-google-workspace',
        'auth_exchange_code',
        { code, state }
      );
      if (typeof tokensString !== 'string') {
        res.status(500).json({ success: false, error: `Invalid tokensString type: ${typeof tokensString}` });
        return;
      }
      
      const parsedState = JSON.parse(state);
      const userId = parsedState.userId;

      // Use the existing Secrets service to store the tokens
      await this.secretsService.updateSecret({
        username: userId,
        secretName: 'google_tokens', // Use a consistent key
        secretValue: tokensString, // Store the full JSON string
        action: 'update'
      });

      res.send('Authentication successful! You can close this tab.');
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }
}
