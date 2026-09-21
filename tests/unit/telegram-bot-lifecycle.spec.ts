import { TelegramBotService } from '../../src/modules/telegram/telegram-bot.service';
import { EnvironmentConfigService } from '../../src/infrastructure/config/environment-config.service';
import { TelegramMode } from '../../src/infrastructure/config/environment.variables';

describe('TelegramBotService Lifecycle', () => {
  let service: TelegramBotService;
  let config: jest.Mocked<any>;
  let mockRequestIdMiddleware: any;
  let mockAuthMiddleware: any;
  let mockExceptionFilter: any;
  let mockStartHandler: any;
  let mockHelpHandler: any;
  let mockWizardHandler: any;
  let mockDraftManagerHandler: any;
  let mockReviewQueueHandler: any;
  let mockPostActionsHandler: any;

  beforeEach(() => {
    config = {
      botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      telegramMode: TelegramMode.POLLING,
      webhookDomain: 'https://example.com',
      webhookPath: '/telegram/webhook',
      webhookSecretToken: 'secret',
      isTest: true,
    };

    mockRequestIdMiddleware = { create: () => jest.fn() };
    mockAuthMiddleware = { create: () => jest.fn() };
    mockExceptionFilter = { create: () => jest.fn(), handleError: jest.fn() };
    mockStartHandler = { handle: jest.fn() };
    mockHelpHandler = { handle: jest.fn() };
    mockWizardHandler = {
      handleStartWizard: jest.fn(),
      handleChannelSelect: jest.fn(),
      handleTemplateSelect: jest.fn(),
      handleSkipField: jest.fn(),
      handleFinishMedia: jest.fn(),
      handleCancelWizard: jest.fn(),
      handleMediaUpload: jest.fn(),
      handleTextInput: jest.fn(),
    };
    mockDraftManagerHandler = {
      handleListDrafts: jest.fn(),
      handleResumeDraft: jest.fn(),
      handlePromptDeleteDraft: jest.fn(),
      handleConfirmDeleteDraft: jest.fn(),
      handleEditFieldPrompt: jest.fn(),
      handleTextInput: jest.fn(),
    };
    mockReviewQueueHandler = {
      handleOpenReviewQueue: jest.fn(),
      handleCardNavigation: jest.fn(),
      handleApprove: jest.fn(),
      handleRequestRevisionPrompt: jest.fn(),
      handleRejectPrompt: jest.fn(),
      handleConfirmReject: jest.fn(),
      handleTextInput: jest.fn(),
    };
    mockPostActionsHandler = {
      handleSubmitForReview: jest.fn(),
      handlePromptDeleteDraft: jest.fn(),
      handleConfirmDeleteDraft: jest.fn(),
      handleViewPost: jest.fn(),
      handleEditPostMenu: jest.fn(),
      handleManageMedia: jest.fn(),
      handlePublishNow: jest.fn(),
      handleSchedulePrompt: jest.fn(),
      handleSchedulePreset: jest.fn(),
      handlePromptCancelSchedule: jest.fn(),
      handleConfirmCancelSchedule: jest.fn(),
      handleRetryPublish: jest.fn(),
      handleTextInput: jest.fn(),
      handleNavMain: jest.fn(),
    };

    service = new TelegramBotService(
      config as unknown as EnvironmentConfigService,
      mockRequestIdMiddleware,
      mockAuthMiddleware,
      mockExceptionFilter,
      mockStartHandler,
      mockHelpHandler,
      mockWizardHandler,
      mockDraftManagerHandler,
      mockReviewQueueHandler,
      mockPostActionsHandler,
    );
  });

  it('should instantiate grammY bot with botToken and register middlewares', () => {
    expect(service.getBotInstance()).toBeDefined();
    expect(service.getBotInstance().token).toBe(config.botToken);
  });

  it('should suppress polling and webhook initialization when isTest === true', async () => {
    const deleteWebhookSpy = jest.spyOn(service.getBotInstance().api, 'deleteWebhook');
    const setWebhookSpy = jest.spyOn(service.getBotInstance().api, 'setWebhook');

    await service.onModuleInit();

    expect(deleteWebhookSpy).not.toHaveBeenCalled();
    expect(setWebhookSpy).not.toHaveBeenCalled();
  });

  it('should cleanly execute onApplicationShutdown without error', async () => {
    await expect(service.onApplicationShutdown('SIGTERM')).resolves.not.toThrow();
  });
});
