class QuoteSummary {
  final String premium;
  final String basePremium;
  final String? premiumWithAddOn;
  final String title;
  final int members;
  final String coverType;
  final int sumInsured;
  final int deductible;
  final String tenure;
  final String plan;
  final String gst;

  QuoteSummary({
    required this.premium,
    required this.basePremium,
    this.premiumWithAddOn,
    required this.title,
    required this.members,
    required this.coverType,
    required this.sumInsured,
    required this.deductible,
    required this.tenure,
    required this.plan,
    required this.gst,
  });

  factory QuoteSummary.fromJson(Map<String, dynamic> json) {
    return QuoteSummary(
      premium: json['premium']?.toString() ?? 'N/A',
      basePremium: json['basePremium']?.toString() ?? 'N/A',
      premiumWithAddOn: json['premiumWithAddOn']?.toString(),
      title: json['title'] ?? 'Care Enhance',
      members: json['members'] ?? 0,
      coverType: json['coverType'] ?? '',
      sumInsured: json['sumInsured'] ?? 0,
      deductible: json['deductible'] ?? 0,
      tenure: json['tenure'] ?? '',
      plan: json['plan'] ?? '',
      gst: json['gst']?.toString() ?? '18',
    );
  }
}

class ChatMessage {
  final String text;
  final bool isUser;
  final DateTime timestamp;
  final QuoteSummary? quote;

  ChatMessage({
    required this.text,
    required this.isUser,
    DateTime? timestamp,
    this.quote,
  }) : timestamp = timestamp ?? DateTime.now();
}
