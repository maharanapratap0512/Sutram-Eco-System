; ═══════════════════════════════════════════════════════════════════════════
; Sutram Dynamic ERP — Full Installable Windows Setup Wizard (Inno Setup 6)
; ═══════════════════════════════════════════════════════════════════════════
; Target Layout created inside user's chosen folder ({app}):
;   {app}\
;   ├── Sutram.exe           (Desktop & Start Menu shortcuts point here)
;   ├── SutramData\          (Preserved across upgrades & uninstall!)
;   │   └── projects\
;   └── sutram\
;       ├── dist\            (Angular UI)
;       ├── sutramServer\    (Backend server)
;       ├── packages\        (Sutram packages)
;       ├── node_modules\    (Pre-built prod deps)
;       ├── runtime\         (Installed automatically if compatible Node.js is missing!)
;       └── package.json
; ═══════════════════════════════════════════════════════════════════════════

#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif
#ifndef AppArch
  #define AppArch "x64"
#endif
#ifndef RequiredNodeMajor
  #define RequiredNodeMajor "20"
#endif
#ifndef StagingDir
  #define StagingDir "..\releases\staging"
#endif
#ifndef OutputDir
  #define OutputDir "..\releases"
#endif
#ifndef AppIcon
  #define AppIcon "..\src-tauri\icons\icon.ico"
#endif

[Setup]
AppId={{8D6B2A1E-5F94-4C0E-9C3B-7A42F1E6B901}
AppName=Sutram Dynamic ERP
AppVersion={#AppVersion}
AppVerName=Sutram Dynamic ERP {#AppVersion}
AppPublisher=Sutram Development Team
DefaultDirName=C:\Sutram
DisableDirPage=no
AlwaysShowDirOnReadyPage=yes
UsePreviousAppDir=yes
DefaultGroupName=Sutram Dynamic ERP
AllowNoIcons=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=Sutram-Setup-v{#AppVersion}-win-{#AppArch}
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\Sutram.exe
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DirExistsWarning=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &Desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "forceruntime"; Description: "Install bundled private Node.js v{#RequiredNodeMajor} runtime even if compatible system Node.js is detected"; GroupDescription: "Node.js Runtime Options:"; Flags: unchecked

[Dirs]
; Create SutramData safely — NEVER removed automatically on uninstall
Name: "{app}\SutramData"; Flags: uninsneveruninstall
Name: "{app}\SutramData\projects"; Flags: uninsneveruninstall

[Files]
; 1. Desktop shell at chosen root folder
Source: "{#StagingDir}\Sutram.exe"; DestDir: "{app}"; Flags: ignoreversion

; 2. SutramData README (only if not already present — never overwrite user data!)
Source: "{#StagingDir}\SutramData\README.txt"; DestDir: "{app}\SutramData"; Flags: onlyifdoesntexist uninsneveruninstall

; 3. Application code, dist/, server, packages, and node_modules (excluding runtime/)
Source: "{#StagingDir}\sutram\*"; DestDir: "{app}\sutram"; Excludes: "runtime\*"; Flags: ignoreversion recursesubdirs createallsubdirs

; 4. Bundled portable Node.js runtime — automatically installed when compatible system Node.js is missing,
;    OR when the user explicitly checks "Install bundled private Node.js runtime"
Source: "{#StagingDir}\sutram\runtime\*"; DestDir: "{app}\sutram\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: ShouldInstallPrivateRuntime

[Icons]
Name: "{group}\Sutram Dynamic ERP"; Filename: "{app}\Sutram.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall Sutram Dynamic ERP"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Sutram Dynamic ERP"; Filename: "{app}\Sutram.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Sutram.exe"; WorkingDir: "{app}"; Description: "Launch Sutram Dynamic ERP"; Flags: nowait postinstall skipifsilent

[Code]
var
  DetectedNodeVersion: string;
  HasCompatibleSystemNode: Boolean;

procedure DetectSystemNode();
var
  TempFile: string;
  ResultCode: Integer;
  OutputText: AnsiString;
  CleanVer: string;
  RequiredPrefix: string;
begin
  DetectedNodeVersion := '';
  HasCompatibleSystemNode := False;
  RequiredPrefix := 'v{#RequiredNodeMajor}.';
  TempFile := ExpandConstant('{tmp}\sutram_node_ver.txt');

  if Exec(ExpandConstant('{cmd}'), '/C node -v > "' + TempFile + '" 2>NUL', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if (ResultCode = 0) and FileExists(TempFile) then
    begin
      if LoadStringFromFile(TempFile, OutputText) then
      begin
        CleanVer := Trim(String(OutputText));
        if Length(CleanVer) > 0 then
        begin
          DetectedNodeVersion := CleanVer;
          if Pos(RequiredPrefix, CleanVer) = 1 then
          begin
            HasCompatibleSystemNode := True;
          end;
        end;
      end;
    end;
  end;

  if FileExists(TempFile) then
    DeleteFile(TempFile);
end;

function InitializeSetup(): Boolean;
begin
  DetectSystemNode();
  Result := True;
end;

function ShouldInstallPrivateRuntime(): Boolean;
begin
  if not HasCompatibleSystemNode then
    Result := True
  else
    Result := WizardIsTaskSelected('forceruntime');
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  S: String;
  NodeNote: String;
begin
  S := '';
  if MemoDirInfo <> '' then
    S := S + MemoDirInfo + NewLine + NewLine;

  if HasCompatibleSystemNode then
  begin
    if WizardIsTaskSelected('forceruntime') then
      NodeNote := 'Node.js Runtime:' + NewLine + Space + 'System Node.js ' + DetectedNodeVersion + ' found, plus installing private bundled Node.js v{#RequiredNodeMajor} runtime.'
    else
      NodeNote := 'Node.js Runtime:' + NewLine + Space + 'Compatible system Node.js (' + DetectedNodeVersion + ') detected — using system Node.js.'
  end
  else if DetectedNodeVersion <> '' then
    NodeNote := 'Node.js Runtime:' + NewLine + Space + 'System Node.js (' + DetectedNodeVersion + ') is a different major version than v{#RequiredNodeMajor}.' + NewLine + Space + 'Bundled private Node.js v{#RequiredNodeMajor} runtime will be installed automatically into sutram\runtime\.'
  else
    NodeNote := 'Node.js Runtime:' + NewLine + Space + 'Node.js not detected on this PC.' + NewLine + Space + 'Bundled private Node.js v{#RequiredNodeMajor} runtime will be installed automatically into sutram\runtime\.';

  S := S + NodeNote + NewLine + NewLine;
  S := S + 'Data Folder (Safe on upgrades):' + NewLine + Space + WizardDirValue + '\SutramData' + NewLine + NewLine;

  if MemoGroupInfo <> '' then
    S := S + MemoGroupInfo + NewLine + NewLine;
  if MemoTasksInfo <> '' then
    S := S + MemoTasksInfo + NewLine;

  Result := S;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{app}\SutramData');
    if DirExists(DataDir) then
    begin
      MsgBox(
        'Sutram Dynamic ERP has been uninstalled.' + #13#10 + #13#10 +
        'Your databases in:' + #13#10 + DataDir + #13#10 +
        'were kept safe and NOT deleted.',
        mbInformation, MB_OK
      );
    end;
  end;
end;
