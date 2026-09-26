export interface TemplateSessionData {
  templateId: string;
  action: 'WAIT_RENAME' | 'WAIT_DESC' | 'WAIT_LAYOUT' | 'WAIT_CLONE_KEY' | 'WAIT_CLONE_NAME' | 'WAIT_FIELD_LABEL' | 'WAIT_FIELD_RENAME' | 'WAIT_FIELD_HINT' | 'WAIT_FIELD_MAX' | 'WAIT_FIELD_MIN';
  tempData?: any;
}
