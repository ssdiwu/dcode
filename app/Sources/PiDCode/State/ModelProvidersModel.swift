import Foundation
import Observation

/// 自定义模型供应商域状态（0.0.16，Pi models.json 合同）：脱敏快照与保存结果。
/// 凭据正文永不进入本模型——只有“已配置”状态与只写输入。
@MainActor
@Observable
final class ModelProvidersModel {
    var snapshot: ModelProviderListResult?
    var isLoading = false
    var isSaving = false
    var issue: String?
}
