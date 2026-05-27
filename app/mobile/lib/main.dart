import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';
import 'screens/chat_screen.dart';

void main() {
  runApp(const ChiChatApp());
}

class ChiChatApp extends StatelessWidget {
  const ChiChatApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Care Health',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1A5276)),
        useMaterial3: true,
        fontFamily: 'Roboto',
      ),
      home: ChatScreen(sessionId: const Uuid().v4()),
    );
  }
}
