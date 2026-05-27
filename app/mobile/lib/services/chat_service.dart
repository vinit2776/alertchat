import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/message.dart';

class ChatService {
  // Change this to your machine's IP when testing on a physical device
  // e.g. 'http://192.168.1.10:3001'
  static const String _baseUrl = 'http://localhost:3001';

  final String sessionId;

  ChatService({required this.sessionId});

  Future<({String message, QuoteSummary? quote})> sendMessage(String text) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/api/chat'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'sessionId': sessionId, 'message': text}),
    );

    if (response.statusCode != 200) {
      throw Exception('Server error: ${response.statusCode}');
    }

    final data = jsonDecode(response.body) as Map<String, dynamic>;

    if (data['success'] != true) {
      throw Exception(data['message'] ?? 'Unknown error');
    }

    final quoteJson = data['quote'] as Map<String, dynamic>?;
    final quote = quoteJson != null ? QuoteSummary.fromJson(quoteJson) : null;

    return (message: data['message'] as String, quote: quote);
  }

  Future<void> resetSession() async {
    await http.delete(Uri.parse('$_baseUrl/api/chat/$sessionId'));
  }
}
