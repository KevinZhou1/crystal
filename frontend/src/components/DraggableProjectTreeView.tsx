import { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Plus, Settings, GripVertical } from 'lucide-react';
import { useSessionStore } from '../stores/sessionStore';
import { useErrorStore } from '../stores/errorStore';
import { SessionListItem } from './SessionListItem';
import { CreateSessionDialog } from './CreateSessionDialog';
import { MainBranchWarningDialog } from './MainBranchWarningDialog';
import ProjectSettings from './ProjectSettings';
import { EmptyState } from './EmptyState';
import { LoadingSpinner } from './LoadingSpinner';
import { API } from '../utils/api';
import type { Session } from '../types/session';
import type { Project } from '../types/project';

interface ProjectWithSessions extends Project {
  sessions: Session[];
}

interface DragState {
  type: 'project' | 'session' | null;
  projectId: number | null;
  sessionId: string | null;
  overType: 'project' | 'session' | null;
  overProjectId: number | null;
  overSessionId: string | null;
}

export function DraggableProjectTreeView() {
  const [projectsWithSessions, setProjectsWithSessions] = useState<ProjectWithSessions[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedProjectForCreate, setSelectedProjectForCreate] = useState<Project | null>(null);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [selectedProjectForSettings, setSelectedProjectForSettings] = useState<Project | null>(null);
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', path: '', mainBranch: 'main', buildScript: '' });
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const [showMainBranchWarning, setShowMainBranchWarning] = useState(false);
  const [pendingMainBranchProject, setPendingMainBranchProject] = useState<Project | null>(null);
  const { showError } = useErrorStore();
  
  // Drag state
  const [dragState, setDragState] = useState<DragState>({
    type: null,
    projectId: null,
    sessionId: null,
    overType: null,
    overProjectId: null,
    overSessionId: null
  });
  const dragCounter = useRef(0);

  useEffect(() => {
    loadProjectsWithSessions();
    
    // Set up event listeners for session updates with targeted updates
    const handleSessionCreated = (newSession: Session) => {
      console.log('[DraggableProjectTreeView] Session created:', newSession.id, 'for project:', newSession.projectId);
      
      if (!newSession.projectId) {
        console.warn('[DraggableProjectTreeView] Session created without projectId, reloading all');
        loadProjectsWithSessions();
        return;
      }
      
      // Add the new session to the appropriate project without reloading everything
      setProjectsWithSessions(prevProjects => {
        const updatedProjects = prevProjects.map(project => {
          if (project.id === newSession.projectId) {
            // Add the new session to this project
            return {
              ...project,
              sessions: [...project.sessions, newSession]
            };
          }
          return project;
        });
        
        // If no project was found, log a warning
        if (!updatedProjects.some(p => p.id === newSession.projectId)) {
          console.warn('[DraggableProjectTreeView] No matching project found for session projectId:', newSession.projectId);
        }
        
        return updatedProjects;
      });
      
      // Auto-expand the project that contains the new session
      if (newSession.projectId) {
        setExpandedProjects(prev => new Set([...prev, newSession.projectId!]));
      }
    };
    
    const handleSessionUpdated = (updatedSession: Session) => {
      console.log('[DraggableProjectTreeView] Session updated event received:', updatedSession);
      console.log('[DraggableProjectTreeView] Updated session isFavorite:', updatedSession.isFavorite);
      
      // Update only the specific session that changed
      setProjectsWithSessions(prevProjects => 
        prevProjects.map(project => {
          // Find the project that contains this session
          const sessionIndex = project.sessions.findIndex(s => s.id === updatedSession.id);
          if (sessionIndex !== -1) {
            // Update the session in this project by merging the updates
            const updatedSessions = [...project.sessions];
            // Merge the updated fields with the existing session to preserve all data
            updatedSessions[sessionIndex] = {
              ...updatedSessions[sessionIndex],
              ...updatedSession
            };
            console.log('[DraggableProjectTreeView] Updated session after merge:', updatedSessions[sessionIndex]);
            return {
              ...project,
              sessions: updatedSessions
            };
          }
          return project;
        })
      );
    };
    
    const handleSessionDeleted = (deletedSession: Session) => {
      // Remove the deleted session from the appropriate project without reloading everything
      setProjectsWithSessions(prevProjects => 
        prevProjects.map(project => {
          const sessionIndex = project.sessions.findIndex(s => s.id === deletedSession.id);
          if (sessionIndex !== -1) {
            // Remove the session from this project
            const updatedSessions = project.sessions.filter(s => s.id !== deletedSession.id);
            return {
              ...project,
              sessions: updatedSessions
            };
          }
          return project;
        })
      );
    };
    
    // Listen for IPC events
    if (window.electronAPI?.events) {
      const unsubscribeCreated = window.electronAPI.events.onSessionCreated(handleSessionCreated);
      const unsubscribeUpdated = window.electronAPI.events.onSessionUpdated(handleSessionUpdated);
      const unsubscribeDeleted = window.electronAPI.events.onSessionDeleted(handleSessionDeleted);
      
      return () => {
        unsubscribeCreated();
        unsubscribeUpdated();
        unsubscribeDeleted();
      };
    }
  }, []);

  const loadProjectsWithSessions = async () => {
    try {
      setIsLoading(true);
      const response = await API.sessions.getAllWithProjects();
      if (response.success && response.data) {
        setProjectsWithSessions(response.data);
        
        // Auto-expand projects that have sessions
        const projectsToExpand = new Set<number>();
        response.data.forEach((project: ProjectWithSessions) => {
          if (project.sessions.length > 0) {
            projectsToExpand.add(project.id);
          }
        });
        setExpandedProjects(projectsToExpand);
        
        // Also expand the project containing the active session
        if (activeSessionId) {
          response.data.forEach((project: ProjectWithSessions) => {
            if (project.sessions.some(s => s.id === activeSessionId)) {
              projectsToExpand.add(project.id);
            }
          });
        }
      }
    } catch (error) {
      console.error('Failed to load projects with sessions:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleProject = (projectId: number) => {
    setExpandedProjects(prev => {
      const newSet = new Set(prev);
      if (newSet.has(projectId)) {
        newSet.delete(projectId);
      } else {
        newSet.add(projectId);
      }
      return newSet;
    });
  };

  const handleProjectClick = async (project: Project) => {
    // Check if we should show the warning
    const warningKey = `mainBranchWarning_${project.id}`;
    const hasShownWarning = localStorage.getItem(warningKey);
    
    if (!hasShownWarning) {
      // Show warning dialog
      setPendingMainBranchProject(project);
      setShowMainBranchWarning(true);
    } else {
      // Proceed directly
      await openMainRepoSession(project);
    }
  };
  
  const openMainRepoSession = async (project: Project) => {
    try {
      // Get or create the main repo session
      const response = await API.sessions.getOrCreateMainRepoSession(project.id);
      
      if (response.success && response.data) {
        // Navigate to the main repo session
        const session = response.data;
        useSessionStore.getState().setActiveSession(session.id);
        
        // Don't expand the project - main repo sessions are accessed via folder click only
      } else {
        showError({
          title: 'Failed to open main repository session',
          error: response.error || 'Unknown error occurred'
        });
      }
    } catch (error: any) {
      console.error('Error handling project click:', error);
      showError({
        title: 'Failed to open main repository session',
        error: error.message || 'Unknown error occurred'
      });
    }
  };

  const handleCreateSession = (project: Project) => {
    // Just show the dialog for any project
    setSelectedProjectForCreate(project);
    setShowCreateDialog(true);
  };

  const detectCurrentBranch = async (path: string) => {
    if (!path) return;
    
    try {
      const response = await API.projects.detectBranch(path);
      if (response.success && response.data) {
        setNewProject(prev => ({ ...prev, mainBranch: response.data }));
      }
    } catch (error) {
      console.log('Could not detect branch, using default');
    }
  };

  const handleCreateProject = async () => {
    if (!newProject.name || !newProject.path) return;

    try {
      const response = await API.projects.create(newProject);

      if (!response.success) {
        showError({
          title: 'Failed to Create Project',
          error: response.error || 'An error occurred while creating the project.',
          details: response.details,
          command: response.command
        });
        return;
      }

      setShowAddProjectDialog(false);
      setNewProject({ name: '', path: '', mainBranch: 'main', buildScript: '' });
      
      // Add the new project to the list without reloading everything
      const newProjectWithSessions = { ...response.data, sessions: [] };
      setProjectsWithSessions(prev => [...prev, newProjectWithSessions]);
    } catch (error: any) {
      console.error('Failed to create project:', error);
      showError({
        title: 'Failed to Create Project',
        error: error.message || 'An error occurred while creating the project.',
        details: error.stack || error.toString()
      });
    }
  };

  // Drag and drop handlers
  const handleProjectDragStart = (e: React.DragEvent, project: Project) => {
    e.stopPropagation();
    setDragState({
      type: 'project',
      projectId: project.id,
      sessionId: null,
      overType: null,
      overProjectId: null,
      overSessionId: null
    });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'project', id: project.id }));
  };

  const handleSessionDragStart = (e: React.DragEvent, session: Session, projectId: number) => {
    e.stopPropagation();
    setDragState({
      type: 'session',
      projectId: projectId,
      sessionId: session.id,
      overType: null,
      overProjectId: null,
      overSessionId: null
    });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'session', id: session.id, projectId }));
  };

  const handleDragEnd = () => {
    setDragState({
      type: null,
      projectId: null,
      sessionId: null,
      overType: null,
      overProjectId: null,
      overSessionId: null
    });
    dragCounter.current = 0;
  };

  const handleProjectDragOver = (e: React.DragEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (dragState.type === 'project' && dragState.projectId !== project.id) {
      setDragState(prev => ({
        ...prev,
        overType: 'project',
        overProjectId: project.id,
        overSessionId: null
      }));
    }
  };

  const handleSessionDragOver = (e: React.DragEvent, session: Session, projectId: number) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Only allow session reordering within the same project
    if (dragState.type === 'session' && 
        dragState.projectId === projectId && 
        dragState.sessionId !== session.id) {
      setDragState(prev => ({
        ...prev,
        overType: 'session',
        overProjectId: projectId,
        overSessionId: session.id
      }));
    }
  };

  const handleProjectDrop = async (e: React.DragEvent, targetProject: Project) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (dragState.type === 'project' && dragState.projectId && dragState.projectId !== targetProject.id) {
      // Reorder projects
      const sourceIndex = projectsWithSessions.findIndex(p => p.id === dragState.projectId);
      const targetIndex = projectsWithSessions.findIndex(p => p.id === targetProject.id);
      
      if (sourceIndex !== -1 && targetIndex !== -1) {
        const newProjects = [...projectsWithSessions];
        const [removed] = newProjects.splice(sourceIndex, 1);
        newProjects.splice(targetIndex, 0, removed);
        
        // Update display order for all projects
        const projectOrders = newProjects.map((project, index) => ({
          id: project.id,
          displayOrder: index
        }));
        
        try {
          const response = await API.projects.reorder(projectOrders);
          if (response.success) {
            setProjectsWithSessions(newProjects);
          } else {
            showError({
              title: 'Failed to reorder projects',
              error: response.error || 'Unknown error occurred'
            });
          }
        } catch (error: any) {
          console.error('Failed to reorder projects:', error);
          showError({
            title: 'Failed to reorder projects',
            error: error.message || 'Unknown error occurred'
          });
        }
      }
    }
    
    handleDragEnd();
  };

  const handleSessionDrop = async (e: React.DragEvent, targetSession: Session, projectId: number) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (dragState.type === 'session' && 
        dragState.sessionId && 
        dragState.projectId === projectId && 
        dragState.sessionId !== targetSession.id) {
      // Reorder sessions within the same project
      const project = projectsWithSessions.find(p => p.id === projectId);
      if (!project) return;
      
      const sourceIndex = project.sessions.findIndex(s => s.id === dragState.sessionId);
      const targetIndex = project.sessions.findIndex(s => s.id === targetSession.id);
      
      if (sourceIndex !== -1 && targetIndex !== -1) {
        const newSessions = [...project.sessions];
        const [removed] = newSessions.splice(sourceIndex, 1);
        newSessions.splice(targetIndex, 0, removed);
        
        // Update display order for all sessions in this project
        const sessionOrders = newSessions.map((session, index) => ({
          id: session.id,
          displayOrder: index
        }));
        
        try {
          const response = await API.sessions.reorder(sessionOrders);
          if (response.success) {
            // Update local state
            const newProjects = projectsWithSessions.map(p => 
              p.id === projectId ? { ...p, sessions: newSessions } : p
            );
            setProjectsWithSessions(newProjects);
          } else {
            showError({
              title: 'Failed to reorder sessions',
              error: response.error || 'Unknown error occurred'
            });
          }
        } catch (error: any) {
          console.error('Failed to reorder sessions:', error);
          showError({
            title: 'Failed to reorder sessions',
            error: error.message || 'Unknown error occurred'
          });
        }
      }
    }
    
    handleDragEnd();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragState(prev => ({
        ...prev,
        overType: null,
        overProjectId: null,
        overSessionId: null
      }));
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner text="Loading projects..." size="small" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-1 px-2 pb-2">
        {projectsWithSessions.length === 0 ? (
          <EmptyState
            icon={Folder}
            title="No Projects Yet"
            description="Add your first project to start managing Claude Code sessions."
            action={{
              label: 'Add Project',
              onClick: () => setShowAddProjectDialog(true)
            }}
            className="py-8"
          />
        ) : (
          <>
            {projectsWithSessions.map((project) => {
          const isExpanded = expandedProjects.has(project.id);
          const sessionCount = project.sessions.length;
          const isDraggingOver = dragState.overType === 'project' && dragState.overProjectId === project.id;
          
          return (
            <div key={project.id}>
              <div 
                className={`group flex items-center space-x-1 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${
                  isDraggingOver ? 'bg-blue-100 dark:bg-blue-900' : ''
                }`}
                draggable
                onDragStart={(e) => handleProjectDragStart(e, project)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleProjectDragOver(e, project)}
                onDrop={(e) => handleProjectDrop(e, project)}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
              >
                <div className="opacity-0 group-hover:opacity-100 transition-opacity cursor-move">
                  <GripVertical className="w-3 h-3 text-gray-400" />
                </div>
                
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleProject(project.id);
                  }}
                  className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                  disabled={sessionCount === 0}
                >
                  {sessionCount > 0 ? (
                    isExpanded ? (
                      <ChevronDown className="w-3 h-3 text-gray-600 dark:text-gray-400" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-gray-600 dark:text-gray-400" />
                    )
                  ) : (
                    <div className="w-3 h-3" />
                  )}
                </button>
                
                <div 
                  className="flex items-center space-x-2 flex-1 min-w-0"
                  onClick={() => handleProjectClick(project)}
                >
                  {isExpanded ? (
                    <FolderOpen className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                  ) : (
                    <Folder className="w-4 h-4 text-gray-600 dark:text-gray-400 flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate text-left">
                    {project.name}
                  </span>
                </div>
                
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCreateSession(project);
                  }}
                  className={`relative p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors group/tooltip ${
                    sessionCount === 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <Plus className="w-4 h-4 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200" />
                  <span className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-2 py-1 text-xs text-white bg-gray-800 dark:bg-gray-700 rounded whitespace-nowrap opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all duration-200 pointer-events-none z-50">
                    Create new session
                    <span className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-4 border-transparent border-t-gray-800 dark:border-t-gray-700"></span>
                  </span>
                </button>
                
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedProjectForSettings(project);
                    setShowProjectSettings(true);
                  }}
                  className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors opacity-0 group-hover:opacity-100"
                  title="Project settings"
                >
                  <Settings className="w-3 h-3 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200" />
                </button>
              </div>
              
              {isExpanded && sessionCount > 0 && (
                <div className="ml-4 mt-1 space-y-1">
                  {project.sessions
                    .sort((a, b) => {
                      // Sort by display order only
                      return (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
                    })
                    .map((session) => {
                    const isDraggingOverSession = dragState.overType === 'session' && 
                                                 dragState.overSessionId === session.id &&
                                                 dragState.overProjectId === project.id;
                    
                    return (
                      <div
                        key={session.id}
                        className={`group flex items-center ${
                          isDraggingOverSession ? 'bg-blue-100 dark:bg-blue-900 rounded' : ''
                        }`}
                        draggable
                        onDragStart={(e) => handleSessionDragStart(e, session, project.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleSessionDragOver(e, session, project.id)}
                        onDrop={(e) => handleSessionDrop(e, session, project.id)}
                        onDragEnter={handleDragEnter}
                        onDragLeave={handleDragLeave}
                      >
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity cursor-move pl-1">
                          <GripVertical className="w-3 h-3 text-gray-400" />
                        </div>
                        <SessionListItem 
                          key={session.id} 
                          session={session}
                          isNested
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        
            <button
              onClick={() => setShowAddProjectDialog(true)}
              className="w-full mt-2 px-2 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors flex items-center justify-center space-x-2"
            >
              <Plus className="w-4 h-4" />
              <span>New Project</span>
            </button>
          </>
        )}
      </div>

      {showCreateDialog && (
        <CreateSessionDialog
          isOpen={showCreateDialog}
          onClose={() => {
            setShowCreateDialog(false);
            setSelectedProjectForCreate(null);
          }}
          projectName={selectedProjectForCreate?.name}
          projectId={selectedProjectForCreate?.id}
        />
      )}
      
      {selectedProjectForSettings && (
        <ProjectSettings
          project={selectedProjectForSettings}
          isOpen={showProjectSettings}
          onClose={() => {
            setShowProjectSettings(false);
            setSelectedProjectForSettings(null);
          }}
          onUpdate={() => {
            // Project updates don't affect sessions, so we can just refresh projects
            // This is still a refresh but limited to project data only
            loadProjectsWithSessions();
          }}
          onDelete={() => {
            // Remove the deleted project from the list without reloading
            if (selectedProjectForSettings) {
              setProjectsWithSessions(prev => 
                prev.filter(p => p.id !== selectedProjectForSettings.id)
              );
            }
          }}
        />
      )}
      
      {/* Add Project Dialog */}
      {showAddProjectDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 shadow-xl border border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-4">Add New Project</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  value={newProject.name}
                  onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-gray-900 dark:text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-500 dark:placeholder-gray-400"
                  placeholder="My Project"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Repository Path
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newProject.path}
                    onChange={(e) => {
                      setNewProject({ ...newProject, path: e.target.value });
                      detectCurrentBranch(e.target.value);
                    }}
                    className="flex-1 px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-gray-900 dark:text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-500 dark:placeholder-gray-400"
                    placeholder="/path/to/repository"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const result = await API.dialog.openDirectory({
                        title: 'Select Repository Directory',
                        buttonLabel: 'Select',
                      });
                      if (result.success && result.data) {
                        setNewProject({ ...newProject, path: result.data });
                        detectCurrentBranch(result.data);
                      }
                    }}
                    className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    Browse
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Main Branch <span className="text-red-600 dark:text-red-400">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newProject.mainBranch}
                    onChange={(e) => setNewProject({ ...newProject, mainBranch: e.target.value })}
                    className="flex-1 px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-gray-900 dark:text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-500 dark:placeholder-gray-400"
                    placeholder="main"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => detectCurrentBranch(newProject.path)}
                    disabled={!newProject.path}
                    className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Auto-detect
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  This must be the branch currently checked out in the folder. Defaults to 'main' for new repos.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Build Script <span className="text-gray-500 dark:text-gray-500">(optional)</span>
                </label>
                <input
                  type="text"
                  value={newProject.buildScript}
                  onChange={(e) => setNewProject({ ...newProject, buildScript: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-gray-900 dark:text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-500 dark:placeholder-gray-400"
                  placeholder="e.g., pnpm build or npm run build"
                />
                <p className="text-xs text-gray-500 mt-1">
                  This script will run automatically before each Claude Code session starts.
                </p>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => {
                  setShowAddProjectDialog(false);
                  setNewProject({ name: '', path: '', mainBranch: 'main', buildScript: '' });
                }}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProject.name || !newProject.path || !newProject.mainBranch}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Add Project
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Main Branch Warning Dialog */}
      {pendingMainBranchProject && (
        <MainBranchWarningDialog
          isOpen={showMainBranchWarning}
          onClose={() => {
            setShowMainBranchWarning(false);
            setPendingMainBranchProject(null);
          }}
          onContinue={() => {
            setShowMainBranchWarning(false);
            if (pendingMainBranchProject) {
              openMainRepoSession(pendingMainBranchProject);
            }
            setPendingMainBranchProject(null);
          }}
          projectName={pendingMainBranchProject.name}
          projectId={pendingMainBranchProject.id}
          mainBranch={pendingMainBranchProject.main_branch || 'main'}
        />
      )}
    </>
  );
}