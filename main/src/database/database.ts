import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Project, ProjectRunCommand, Session, SessionOutput, CreateSessionData, UpdateSessionData, ConversationMessage, PromptMarker, ExecutionDiff, CreateExecutionDiffData } from './models';

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure the directory exists before creating the database
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    
    this.db = new Database(dbPath);
  }

  initialize(): void {
    this.initializeSchema();
    this.runMigrations();
  }

  private initializeSchema(): void {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    
    // Execute schema in parts (sqlite3 doesn't support multiple statements in exec)
    const statements = schema.split(';').filter(stmt => stmt.trim());
    for (const statement of statements) {
      if (statement.trim()) {
        this.db.prepare(statement.trim()).run();
      }
    }
  }

  private runMigrations(): void {
    // Check if archived column exists
    const tableInfo = this.db.prepare("PRAGMA table_info(sessions)").all();
    const hasArchivedColumn = tableInfo.some((col: any) => col.name === 'archived');
    const hasInitialPromptColumn = tableInfo.some((col: any) => col.name === 'initial_prompt');
    const hasLastViewedAtColumn = tableInfo.some((col: any) => col.name === 'last_viewed_at');
    
    if (!hasArchivedColumn) {
      // Run migration to add archived column
      this.db.prepare("ALTER TABLE sessions ADD COLUMN archived BOOLEAN DEFAULT 0").run();
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived)").run();
    }

    // Check if we need to rename prompt to initial_prompt
    if (!hasInitialPromptColumn) {
      const hasPromptColumn = tableInfo.some((col: any) => col.name === 'prompt');
      if (hasPromptColumn) {
        this.db.prepare("ALTER TABLE sessions RENAME COLUMN prompt TO initial_prompt").run();
      }
      
      // Create conversation messages table if it doesn't exist
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_messages'").all();
      if (tables.length === 0) {
        this.db.prepare(`
          CREATE TABLE conversation_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            message_type TEXT NOT NULL CHECK (message_type IN ('user', 'assistant')),
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          )
        `).run();
        this.db.prepare("CREATE INDEX idx_conversation_messages_session_id ON conversation_messages(session_id)").run();
        this.db.prepare("CREATE INDEX idx_conversation_messages_timestamp ON conversation_messages(timestamp)").run();
      }
    }

    // Check if prompt_markers table exists
    const promptMarkersTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_markers'").all();
    if (promptMarkersTable.length === 0) {
      this.db.prepare(`
        CREATE TABLE prompt_markers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          prompt_text TEXT NOT NULL,
          output_index INTEGER NOT NULL,
          output_line INTEGER,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `).run();
      this.db.prepare("CREATE INDEX idx_prompt_markers_session_id ON prompt_markers(session_id)").run();
      this.db.prepare("CREATE INDEX idx_prompt_markers_timestamp ON prompt_markers(timestamp)").run();
    } else {
      // Check if the table has the correct column name
      const promptMarkersInfo = this.db.prepare("PRAGMA table_info(prompt_markers)").all();
      const hasOutputLineColumn = promptMarkersInfo.some((col: any) => col.name === 'output_line');
      const hasTerminalLineColumn = promptMarkersInfo.some((col: any) => col.name === 'terminal_line');
      
      if (hasTerminalLineColumn && !hasOutputLineColumn) {
        // Rename the column from terminal_line to output_line
        this.db.prepare(`
          ALTER TABLE prompt_markers RENAME COLUMN terminal_line TO output_line
        `).run();
      }
    }

    // Check if execution_diffs table exists
    const executionDiffsTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_diffs'").all();
    if (executionDiffsTable.length === 0) {
      this.db.prepare(`
        CREATE TABLE execution_diffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          prompt_marker_id INTEGER,
          execution_sequence INTEGER NOT NULL,
          git_diff TEXT,
          files_changed TEXT,
          stats_additions INTEGER DEFAULT 0,
          stats_deletions INTEGER DEFAULT 0,
          stats_files_changed INTEGER DEFAULT 0,
          before_commit_hash TEXT,
          after_commit_hash TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (prompt_marker_id) REFERENCES prompt_markers(id) ON DELETE SET NULL
        )
      `).run();
      this.db.prepare("CREATE INDEX idx_execution_diffs_session_id ON execution_diffs(session_id)").run();
      this.db.prepare("CREATE INDEX idx_execution_diffs_prompt_marker_id ON execution_diffs(prompt_marker_id)").run();
      this.db.prepare("CREATE INDEX idx_execution_diffs_timestamp ON execution_diffs(timestamp)").run();
      this.db.prepare("CREATE INDEX idx_execution_diffs_sequence ON execution_diffs(session_id, execution_sequence)").run();
    }

    // Add last_viewed_at column if it doesn't exist
    if (!hasLastViewedAtColumn) {
      this.db.prepare("ALTER TABLE sessions ADD COLUMN last_viewed_at TEXT").run();
    }

    // Check if claude_session_id column exists
    const sessionTableInfoClaude = this.db.prepare("PRAGMA table_info(sessions)").all();
    const hasClaudeSessionIdColumn = sessionTableInfoClaude.some((col: any) => col.name === 'claude_session_id');
    
    if (!hasClaudeSessionIdColumn) {
      // Add claude_session_id column to store Claude's actual session ID
      this.db.prepare("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT").run();
    }

    // Check if permission_mode column exists
    const hasPermissionModeColumn = sessionTableInfoClaude.some((col: any) => col.name === 'permission_mode');
    
    if (!hasPermissionModeColumn) {
      // Add permission_mode column to sessions table
      this.db.prepare("ALTER TABLE sessions ADD COLUMN permission_mode TEXT DEFAULT 'ignore' CHECK(permission_mode IN ('approve', 'ignore'))").run();
    }

    // Add project support migration
    const projectsTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").all();
    if (projectsTable.length === 0) {
      // Create projects table
      this.db.prepare(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          system_prompt TEXT,
          run_script TEXT,
          active BOOLEAN NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      
      // Add project_id to sessions table
      const sessionsTableInfoProjects = this.db.prepare("PRAGMA table_info(sessions)").all();
      const hasProjectIdColumn = sessionsTableInfoProjects.some((col: any) => col.name === 'project_id');
      
      if (!hasProjectIdColumn) {
        this.db.prepare("ALTER TABLE sessions ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE").run();
        this.db.prepare("CREATE INDEX idx_sessions_project_id ON sessions(project_id)").run();
      }

      // Import existing config as default project if it exists
      try {
        const configManager = require('../services/configManager').configManager;
        const gitRepoPath = configManager.getGitRepoPath();
        
        if (gitRepoPath) {
          const projectName = gitRepoPath.split('/').pop() || 'Default Project';
          const result = this.db.prepare(`
            INSERT INTO projects (name, path, active)
            VALUES (?, ?, 1)
          `).run(projectName, gitRepoPath);
          
          // Update existing sessions to use this project
          if (result.lastInsertRowid) {
            this.db.prepare(`
              UPDATE sessions 
              SET project_id = ?
              WHERE project_id IS NULL
            `).run(result.lastInsertRowid);
          }
        }
      } catch (error) {
        // Config manager not available during initial setup
        console.log('Skipping default project creation during initial setup');
      }
    }

    // Add is_main_repo column to sessions table if it doesn't exist
    const sessionTableInfoForMainRepo = this.db.prepare("PRAGMA table_info(sessions)").all();
    const hasIsMainRepoColumn = sessionTableInfoForMainRepo.some((col: any) => col.name === 'is_main_repo');
    
    if (!hasIsMainRepoColumn) {
      this.db.prepare("ALTER TABLE sessions ADD COLUMN is_main_repo BOOLEAN DEFAULT 0").run();
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_is_main_repo ON sessions(is_main_repo, project_id)").run();
    }

    // Add main_branch column to projects table if it doesn't exist
    const projectsTableInfo = this.db.prepare("PRAGMA table_info(projects)").all();
    const hasMainBranchColumn = projectsTableInfo.some((col: any) => col.name === 'main_branch');
    
    if (!hasMainBranchColumn) {
      this.db.prepare("ALTER TABLE projects ADD COLUMN main_branch TEXT").run();
    }

    // Add build_script column to projects table if it doesn't exist
    const hasBuildScriptColumn = projectsTableInfo.some((col: any) => col.name === 'build_script');
    
    if (!hasBuildScriptColumn) {
      this.db.prepare("ALTER TABLE projects ADD COLUMN build_script TEXT").run();
    }

    // Add default_permission_mode column to projects table if it doesn't exist
    const hasDefaultPermissionModeColumn = projectsTableInfo.some((col: any) => col.name === 'default_permission_mode');
    
    if (!hasDefaultPermissionModeColumn) {
      this.db.prepare("ALTER TABLE projects ADD COLUMN default_permission_mode TEXT DEFAULT 'ignore' CHECK(default_permission_mode IN ('approve', 'ignore'))").run();
    }

    // Add open_ide_command column to projects table if it doesn't exist
    const hasOpenIdeCommandColumn = projectsTableInfo.some((col: any) => col.name === 'open_ide_command');
    
    if (!hasOpenIdeCommandColumn) {
      this.db.prepare("ALTER TABLE projects ADD COLUMN open_ide_command TEXT").run();
    }

    // Create project_run_commands table if it doesn't exist
    const runCommandsTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_run_commands'").all();
    if (runCommandsTable.length === 0) {
      this.db.prepare(`
        CREATE TABLE project_run_commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          command TEXT NOT NULL,
          display_name TEXT,
          order_index INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `).run();
      this.db.prepare("CREATE INDEX idx_project_run_commands_project_id ON project_run_commands(project_id)").run();
      
      // Migrate existing run_script data to the new table
      const projectsWithRunScripts = this.db.prepare("SELECT id, run_script FROM projects WHERE run_script IS NOT NULL").all() as Array<{id: number; run_script: string}>;
      for (const project of projectsWithRunScripts) {
        if (project.run_script) {
          this.db.prepare(`
            INSERT INTO project_run_commands (project_id, command, display_name, order_index)
            VALUES (?, ?, 'Default Run Command', 0)
          `).run(project.id, project.run_script);
        }
      }
    }
    
    // Check if display_order columns exist
    const projectsTableInfo2 = this.db.prepare("PRAGMA table_info(projects)").all();
    const sessionsTableInfo2 = this.db.prepare("PRAGMA table_info(sessions)").all();
    const hasProjectsDisplayOrder = projectsTableInfo2.some((col: any) => col.name === 'display_order');
    const hasSessionsDisplayOrder = sessionsTableInfo2.some((col: any) => col.name === 'display_order');
    
    if (!hasProjectsDisplayOrder) {
      // Add display_order to projects
      this.db.prepare("ALTER TABLE projects ADD COLUMN display_order INTEGER").run();
      
      // Initialize display_order for existing projects
      this.db.prepare(`
        UPDATE projects 
        SET display_order = (
          SELECT COUNT(*) 
          FROM projects p2 
          WHERE p2.created_at <= projects.created_at OR (p2.created_at = projects.created_at AND p2.id <= projects.id)
        ) - 1
        WHERE display_order IS NULL
      `).run();
      
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_projects_display_order ON projects(display_order)").run();
    }
    
    if (!hasSessionsDisplayOrder) {
      // Add display_order to sessions
      this.db.prepare("ALTER TABLE sessions ADD COLUMN display_order INTEGER").run();
      
      // Initialize display_order for existing sessions within each project
      this.db.prepare(`
        UPDATE sessions 
        SET display_order = (
          SELECT COUNT(*) 
          FROM sessions s2 
          WHERE s2.project_id = sessions.project_id 
          AND (s2.created_at < sessions.created_at OR (s2.created_at = sessions.created_at AND s2.id <= sessions.id))
        ) - 1
        WHERE display_order IS NULL
      `).run();
      
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_display_order ON sessions(project_id, display_order)").run();
    }
    
    // Normalize timestamp fields migration
    // Check if last_viewed_at is still TEXT type
    const sessionTableInfoTimestamp = this.db.prepare("PRAGMA table_info(sessions)").all();
    const lastViewedAtColumn = sessionTableInfoTimestamp.find((col: any) => col.name === 'last_viewed_at') as any;
    
    if (lastViewedAtColumn && lastViewedAtColumn.type === 'TEXT') {
      console.log('[Database] Running timestamp normalization migration...');
      
      try {
        // Create new temporary columns with DATETIME type
        this.db.prepare("ALTER TABLE sessions ADD COLUMN last_viewed_at_new DATETIME").run();
        this.db.prepare("ALTER TABLE sessions ADD COLUMN run_started_at_new DATETIME").run();
        
        // Copy and convert existing data
        this.db.prepare("UPDATE sessions SET last_viewed_at_new = datetime(last_viewed_at) WHERE last_viewed_at IS NOT NULL").run();
        this.db.prepare("UPDATE sessions SET run_started_at_new = datetime(run_started_at) WHERE run_started_at IS NOT NULL").run();
        
        // Create a backup of the table with proper schema
        this.db.prepare(`
          CREATE TABLE sessions_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            initial_prompt TEXT NOT NULL,
            worktree_name TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_output TEXT,
            exit_code INTEGER,
            pid INTEGER,
            claude_session_id TEXT,
            archived BOOLEAN DEFAULT 0,
            last_viewed_at DATETIME,
            project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            permission_mode TEXT DEFAULT 'ignore' CHECK(permission_mode IN ('approve', 'ignore')),
            run_started_at DATETIME,
            is_main_repo BOOLEAN DEFAULT 0,
            display_order INTEGER
          )
        `).run();
        
        // Copy all data to new table
        this.db.prepare(`
          INSERT INTO sessions_new 
          SELECT id, name, initial_prompt, worktree_name, worktree_path, status, 
                 created_at, updated_at, last_output, exit_code, pid, claude_session_id,
                 archived, last_viewed_at_new, project_id, permission_mode, 
                 run_started_at_new, is_main_repo, display_order
          FROM sessions
        `).run();
        
        // Drop old table and rename new one
        this.db.prepare("DROP TABLE sessions").run();
        this.db.prepare("ALTER TABLE sessions_new RENAME TO sessions").run();
        
        // Recreate indexes
        this.db.prepare("CREATE INDEX idx_sessions_archived ON sessions(archived)").run();
        this.db.prepare("CREATE INDEX idx_sessions_project_id ON sessions(project_id)").run();
        this.db.prepare("CREATE INDEX idx_sessions_is_main_repo ON sessions(is_main_repo, project_id)").run();
        this.db.prepare("CREATE INDEX idx_sessions_display_order ON sessions(project_id, display_order)").run();
        
        console.log('[Database] Timestamp normalization migration completed successfully');
      } catch (error) {
        console.error('[Database] Failed to normalize timestamps:', error);
        // Don't throw - allow app to continue with TEXT fields
      }
    }
    
    // Add missing completion_timestamp to prompt_markers if it doesn't exist
    const promptMarkersInfo = this.db.prepare("PRAGMA table_info(prompt_markers)").all();
    const hasCompletionTimestamp = promptMarkersInfo.some((col: any) => col.name === 'completion_timestamp');
    
    if (!hasCompletionTimestamp) {
      this.db.prepare("ALTER TABLE prompt_markers ADD COLUMN completion_timestamp DATETIME").run();
    }
    
    // Add is_favorite column to sessions table if it doesn't exist
    const sessionTableInfoFavorite = this.db.prepare("PRAGMA table_info(sessions)").all();
    const hasIsFavoriteColumn = sessionTableInfoFavorite.some((col: any) => col.name === 'is_favorite');
    
    if (!hasIsFavoriteColumn) {
      this.db.prepare("ALTER TABLE sessions ADD COLUMN is_favorite BOOLEAN DEFAULT 0").run();
      console.log('[Database] Added is_favorite column to sessions table');
    }

    // Add auto_commit column to sessions table if it doesn't exist
    const hasAutoCommitColumn = sessionTableInfoFavorite.some((col: any) => col.name === 'auto_commit');
    
    if (!hasAutoCommitColumn) {
      this.db.prepare("ALTER TABLE sessions ADD COLUMN auto_commit BOOLEAN DEFAULT 1").run();
      console.log('[Database] Added auto_commit column to sessions table');
    }
  }

  // Project operations
  createProject(name: string, path: string, systemPrompt?: string, runScript?: string, mainBranch?: string, buildScript?: string, defaultPermissionMode?: 'approve' | 'ignore', openIdeCommand?: string): Project {
    // Get the max display_order for projects
    const maxOrderResult = this.db.prepare(`
      SELECT MAX(display_order) as max_order 
      FROM projects
    `).get() as { max_order: number | null };
    
    const displayOrder = (maxOrderResult?.max_order ?? -1) + 1;
    
    const result = this.db.prepare(`
      INSERT INTO projects (name, path, system_prompt, run_script, main_branch, build_script, default_permission_mode, open_ide_command, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, path, systemPrompt || null, runScript || null, mainBranch || null, buildScript || null, defaultPermissionMode || 'ignore', openIdeCommand || null, displayOrder);
    
    const project = this.getProject(result.lastInsertRowid as number);
    if (!project) {
      throw new Error('Failed to create project');
    }
    return project;
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  getProjectByPath(path: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Project | undefined;
  }

  getActiveProject(): Project | undefined {
    const project = this.db.prepare('SELECT * FROM projects WHERE active = 1 LIMIT 1').get() as Project | undefined;
    if (project) {
      console.log(`[Database] Retrieved active project:`, {
        id: project.id,
        name: project.name,
        build_script: project.build_script,
        run_script: project.run_script
      });
    }
    return project;
  }

  getAllProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY display_order ASC, created_at ASC').all() as Project[];
  }

  updateProject(id: number, updates: Partial<Omit<Project, 'id' | 'created_at'>>): Project | undefined {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.path !== undefined) {
      fields.push('path = ?');
      values.push(updates.path);
    }
    if (updates.system_prompt !== undefined) {
      fields.push('system_prompt = ?');
      values.push(updates.system_prompt);
    }
    if (updates.run_script !== undefined) {
      fields.push('run_script = ?');
      values.push(updates.run_script);
    }
    if (updates.build_script !== undefined) {
      fields.push('build_script = ?');
      values.push(updates.build_script);
    }
    if (updates.main_branch !== undefined) {
      fields.push('main_branch = ?');
      values.push(updates.main_branch);
    }
    if (updates.default_permission_mode !== undefined) {
      fields.push('default_permission_mode = ?');
      values.push(updates.default_permission_mode);
    }
    if (updates.open_ide_command !== undefined) {
      fields.push('open_ide_command = ?');
      values.push(updates.open_ide_command);
    }
    if (updates.active !== undefined) {
      fields.push('active = ?');
      values.push(updates.active ? 1 : 0);
    }

    if (fields.length === 0) {
      return this.getProject(id);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    this.db.prepare(`
      UPDATE projects 
      SET ${fields.join(', ')} 
      WHERE id = ?
    `).run(...values);
    
    return this.getProject(id);
  }

  setActiveProject(id: number): Project | undefined {
    // First deactivate all projects
    this.db.prepare('UPDATE projects SET active = 0').run();
    
    // Then activate the selected project
    this.db.prepare('UPDATE projects SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    
    return this.getProject(id);
  }

  deleteProject(id: number): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Project run commands operations
  createRunCommand(projectId: number, command: string, displayName?: string, orderIndex?: number): ProjectRunCommand {
    const result = this.db.prepare(`
      INSERT INTO project_run_commands (project_id, command, display_name, order_index)
      VALUES (?, ?, ?, ?)
    `).run(projectId, command, displayName || null, orderIndex || 0);
    
    const runCommand = this.getRunCommand(result.lastInsertRowid as number);
    if (!runCommand) {
      throw new Error('Failed to create run command');
    }
    return runCommand;
  }

  getRunCommand(id: number): ProjectRunCommand | undefined {
    return this.db.prepare('SELECT * FROM project_run_commands WHERE id = ?').get(id) as ProjectRunCommand | undefined;
  }

  getProjectRunCommands(projectId: number): ProjectRunCommand[] {
    return this.db.prepare('SELECT * FROM project_run_commands WHERE project_id = ? ORDER BY order_index ASC, id ASC').all(projectId) as ProjectRunCommand[];
  }

  updateRunCommand(id: number, updates: { command?: string; display_name?: string; order_index?: number }): ProjectRunCommand | undefined {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.command !== undefined) {
      fields.push('command = ?');
      values.push(updates.command);
    }
    if (updates.display_name !== undefined) {
      fields.push('display_name = ?');
      values.push(updates.display_name);
    }
    if (updates.order_index !== undefined) {
      fields.push('order_index = ?');
      values.push(updates.order_index);
    }

    if (fields.length === 0) {
      return this.getRunCommand(id);
    }

    values.push(id);

    this.db.prepare(`
      UPDATE project_run_commands 
      SET ${fields.join(', ')} 
      WHERE id = ?
    `).run(...values);
    
    return this.getRunCommand(id);
  }

  deleteRunCommand(id: number): boolean {
    const result = this.db.prepare('DELETE FROM project_run_commands WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteProjectRunCommands(projectId: number): boolean {
    const result = this.db.prepare('DELETE FROM project_run_commands WHERE project_id = ?').run(projectId);
    return result.changes > 0;
  }

  // Session operations
  createSession(data: CreateSessionData): Session {
    // Get the max display_order for sessions in this project
    const maxOrderResult = this.db.prepare(`
      SELECT MAX(display_order) as max_order 
      FROM sessions 
      WHERE project_id = ? AND (archived = 0 OR archived IS NULL)
    `).get(data.project_id) as { max_order: number | null };
    
    const displayOrder = (maxOrderResult?.max_order ?? -1) + 1;
    
    this.db.prepare(`
      INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, status, project_id, permission_mode, is_main_repo, display_order, auto_commit)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(data.id, data.name, data.initial_prompt, data.worktree_name, data.worktree_path, data.project_id, data.permission_mode || 'ignore', data.is_main_repo ? 1 : 0, displayOrder, data.auto_commit !== undefined ? (data.auto_commit ? 1 : 0) : 1);
    
    const session = this.getSession(data.id);
    if (!session) {
      throw new Error('Failed to create session');
    }
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  getAllSessions(projectId?: number): Session[] {
    if (projectId !== undefined) {
      return this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND (archived = 0 OR archived IS NULL) AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY display_order ASC, created_at DESC').all(projectId) as Session[];
    }
    return this.db.prepare('SELECT * FROM sessions WHERE (archived = 0 OR archived IS NULL) AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY display_order ASC, created_at DESC').all() as Session[];
  }

  getAllSessionsIncludingArchived(): Session[] {
    return this.db.prepare('SELECT * FROM sessions WHERE (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY created_at DESC').all() as Session[];
  }

  getMainRepoSession(projectId: number): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND is_main_repo = 1 AND (archived = 0 OR archived IS NULL)').get(projectId) as Session | undefined;
  }

  updateSession(id: string, data: UpdateSessionData): Session | undefined {
    const updates: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.status !== undefined) {
      updates.push('status = ?');
      values.push(data.status);
    }
    if (data.last_output !== undefined) {
      updates.push('last_output = ?');
      values.push(data.last_output);
    }
    if (data.exit_code !== undefined) {
      updates.push('exit_code = ?');
      values.push(data.exit_code);
    }
    if (data.pid !== undefined) {
      updates.push('pid = ?');
      values.push(data.pid);
    }
    if (data.claude_session_id !== undefined) {
      updates.push('claude_session_id = ?');
      values.push(data.claude_session_id);
    }
    if (data.run_started_at !== undefined) {
      if (data.run_started_at === 'CURRENT_TIMESTAMP') {
        updates.push('run_started_at = CURRENT_TIMESTAMP');
      } else {
        updates.push('run_started_at = ?');
        values.push(data.run_started_at);
      }
    }
    if (data.is_favorite !== undefined) {
      updates.push('is_favorite = ?');
      values.push(data.is_favorite ? 1 : 0);
    }
    if (data.auto_commit !== undefined) {
      updates.push('auto_commit = ?');
      values.push(data.auto_commit ? 1 : 0);
    }

    if (updates.length === 0) {
      return this.getSession(id);
    }

    // Only update the updated_at timestamp if we're changing something other than is_favorite or auto_commit
    // This prevents the session from showing as "unviewed" when just toggling favorites or auto_commit
    const isOnlyToggleUpdate = updates.length === 1 && (updates[0] === 'is_favorite = ?' || updates[0] === 'auto_commit = ?');
    if (!isOnlyToggleUpdate) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
    }
    values.push(id);

    this.db.prepare(`
      UPDATE sessions 
      SET ${updates.join(', ')} 
      WHERE id = ?
    `).run(...values);
    
    return this.getSession(id);
  }

  markSessionAsViewed(id: string): Session | undefined {
    this.db.prepare(`
      UPDATE sessions 
      SET last_viewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(id);
    
    return this.getSession(id);
  }

  archiveSession(id: string): boolean {
    const result = this.db.prepare('UPDATE sessions SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Session output operations
  addSessionOutput(sessionId: string, type: 'stdout' | 'stderr' | 'system' | 'json', data: string): void {
    this.db.prepare(`
      INSERT INTO session_outputs (session_id, type, data)
      VALUES (?, ?, ?)
    `).run(sessionId, type, data);
  }

  getSessionOutputs(sessionId: string, limit?: number): SessionOutput[] {
    const limitClause = limit ? `LIMIT ${limit}` : '';
    return this.db.prepare(`
      SELECT * FROM session_outputs 
      WHERE session_id = ? 
      ORDER BY timestamp ASC 
      ${limitClause}
    `).all(sessionId) as SessionOutput[];
  }

  getRecentSessionOutputs(sessionId: string, since?: Date): SessionOutput[] {
    if (since) {
      return this.db.prepare(`
        SELECT * FROM session_outputs 
        WHERE session_id = ? AND timestamp > ? 
        ORDER BY timestamp ASC
      `).all(sessionId, since.toISOString()) as SessionOutput[];
    } else {
      return this.getSessionOutputs(sessionId);
    }
  }

  clearSessionOutputs(sessionId: string): void {
    this.db.prepare('DELETE FROM session_outputs WHERE session_id = ?').run(sessionId);
  }

  // Conversation message operations
  addConversationMessage(sessionId: string, messageType: 'user' | 'assistant', content: string): void {
    this.db.prepare(`
      INSERT INTO conversation_messages (session_id, message_type, content)
      VALUES (?, ?, ?)
    `).run(sessionId, messageType, content);
  }

  getConversationMessages(sessionId: string): ConversationMessage[] {
    return this.db.prepare(`
      SELECT * FROM conversation_messages 
      WHERE session_id = ? 
      ORDER BY timestamp ASC
    `).all(sessionId) as ConversationMessage[];
  }

  clearConversationMessages(sessionId: string): void {
    this.db.prepare('DELETE FROM conversation_messages WHERE session_id = ?').run(sessionId);
  }

  // Cleanup operations
  getActiveSessions(): Session[] {
    return this.db.prepare("SELECT * FROM sessions WHERE status IN ('running', 'pending')").all() as Session[];
  }

  markSessionsAsStopped(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    
    const placeholders = sessionIds.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE sessions 
      SET status = 'stopped', updated_at = CURRENT_TIMESTAMP 
      WHERE id IN (${placeholders})
    `).run(...sessionIds);
  }

  // Prompt marker operations
  addPromptMarker(sessionId: string, promptText: string, outputIndex: number, outputLine?: number): number {
    console.log('[Database] Adding prompt marker:', { sessionId, promptText, outputIndex, outputLine });
    
    try {
      // Use datetime('now') to ensure UTC timestamp
      const result = this.db.prepare(`
        INSERT INTO prompt_markers (session_id, prompt_text, output_index, output_line, timestamp)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(sessionId, promptText, outputIndex, outputLine);
      
      console.log('[Database] Prompt marker added successfully, ID:', result.lastInsertRowid);
      return result.lastInsertRowid as number;
    } catch (error) {
      console.error('[Database] Failed to add prompt marker:', error);
      throw error;
    }
  }

  getPromptMarkers(sessionId: string): PromptMarker[] {
    const markers = this.db.prepare(`
      SELECT 
        id,
        session_id,
        prompt_text,
        output_index,
        output_line,
        datetime(timestamp) || 'Z' as timestamp,
        CASE 
          WHEN completion_timestamp IS NOT NULL 
          THEN datetime(completion_timestamp) || 'Z'
          ELSE NULL
        END as completion_timestamp
      FROM prompt_markers 
      WHERE session_id = ? 
      ORDER BY timestamp ASC
    `).all(sessionId) as PromptMarker[];
    
    return markers;
  }

  updatePromptMarkerLine(id: number, outputLine: number): void {
    this.db.prepare(`
      UPDATE prompt_markers 
      SET output_line = ? 
      WHERE id = ?
    `).run(outputLine, id);
  }

  updatePromptMarkerCompletion(sessionId: string, timestamp?: string): void {
    // Update the most recent prompt marker for this session with completion timestamp
    // Use datetime() to ensure proper UTC timestamp handling
    if (timestamp) {
      // If timestamp is provided, use datetime() to normalize it
      this.db.prepare(`
        UPDATE prompt_markers 
        SET completion_timestamp = datetime(?) 
        WHERE session_id = ? 
        AND id = (
          SELECT id FROM prompt_markers 
          WHERE session_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 1
        )
      `).run(timestamp, sessionId, sessionId);
    } else {
      // If no timestamp, use current UTC time
      this.db.prepare(`
        UPDATE prompt_markers 
        SET completion_timestamp = datetime('now') 
        WHERE session_id = ? 
        AND id = (
          SELECT id FROM prompt_markers 
          WHERE session_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 1
        )
      `).run(sessionId, sessionId);
    }
  }

  // Execution diff operations
  createExecutionDiff(data: CreateExecutionDiffData): ExecutionDiff {
    const result = this.db.prepare(`
      INSERT INTO execution_diffs (
        session_id, prompt_marker_id, execution_sequence, git_diff, 
        files_changed, stats_additions, stats_deletions, stats_files_changed,
        before_commit_hash, after_commit_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.session_id,
      data.prompt_marker_id || null,
      data.execution_sequence,
      data.git_diff || null,
      data.files_changed ? JSON.stringify(data.files_changed) : null,
      data.stats_additions || 0,
      data.stats_deletions || 0,
      data.stats_files_changed || 0,
      data.before_commit_hash || null,
      data.after_commit_hash || null
    );

    const diff = this.db.prepare('SELECT * FROM execution_diffs WHERE id = ?').get(result.lastInsertRowid);
    return this.convertDbExecutionDiff(diff);
  }

  getExecutionDiffs(sessionId: string): ExecutionDiff[] {
    const rows = this.db.prepare(`
      SELECT * FROM execution_diffs 
      WHERE session_id = ? 
      ORDER BY execution_sequence ASC
    `).all(sessionId);
    
    return rows.map(this.convertDbExecutionDiff);
  }

  getExecutionDiff(id: number): ExecutionDiff | undefined {
    const row = this.db.prepare('SELECT * FROM execution_diffs WHERE id = ?').get(id);
    return row ? this.convertDbExecutionDiff(row) : undefined;
  }

  getNextExecutionSequence(sessionId: string): number {
    const result = this.db.prepare(`
      SELECT MAX(execution_sequence) as max_seq 
      FROM execution_diffs 
      WHERE session_id = ?
    `).get(sessionId) as any;
    
    return (result?.max_seq || 0) + 1;
  }

  private convertDbExecutionDiff(row: any): ExecutionDiff {
    return {
      id: row.id,
      session_id: row.session_id,
      prompt_marker_id: row.prompt_marker_id,
      execution_sequence: row.execution_sequence,
      git_diff: row.git_diff,
      files_changed: row.files_changed ? JSON.parse(row.files_changed) : [],
      stats_additions: row.stats_additions,
      stats_deletions: row.stats_deletions,
      stats_files_changed: row.stats_files_changed,
      before_commit_hash: row.before_commit_hash,
      after_commit_hash: row.after_commit_hash,
      timestamp: row.timestamp
    };
  }

  // Display order operations
  updateProjectDisplayOrder(projectId: number, displayOrder: number): void {
    this.db.prepare(`
      UPDATE projects 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(displayOrder, projectId);
  }

  updateSessionDisplayOrder(sessionId: string, displayOrder: number): void {
    this.db.prepare(`
      UPDATE sessions 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(displayOrder, sessionId);
  }

  reorderProjects(projectOrders: Array<{ id: number; displayOrder: number }>): void {
    const stmt = this.db.prepare(`
      UPDATE projects 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    
    const updateMany = this.db.transaction((orders: Array<{ id: number; displayOrder: number }>) => {
      for (const { id, displayOrder } of orders) {
        stmt.run(displayOrder, id);
      }
    });
    
    updateMany(projectOrders);
  }

  reorderSessions(sessionOrders: Array<{ id: string; displayOrder: number }>): void {
    const stmt = this.db.prepare(`
      UPDATE sessions 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    
    const updateMany = this.db.transaction((orders: Array<{ id: string; displayOrder: number }>) => {
      for (const { id, displayOrder } of orders) {
        stmt.run(displayOrder, id);
      }
    });
    
    updateMany(sessionOrders);
  }

  close(): void {
    this.db.close();
  }
}